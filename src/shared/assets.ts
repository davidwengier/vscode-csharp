/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs-extra';
import * as jsonc from 'jsonc-parser';
import { FormattingOptions, ModificationOptions } from 'jsonc-parser';
import * as os from 'os';
import * as path from 'path';
import * as tasks from 'vscode-tasks';
import * as util from '../common';
import * as vscode from 'vscode';

import { tolerantParse } from '../json';
import { IWorkspaceDebugInformationProvider, ProjectDebugInformation } from './IWorkspaceDebugInformationProvider';

export class AssetGenerator {
    public vscodeFolder: string;
    public tasksJsonPath: string;
    public launchJsonPath: string;

    private executableProjects: ProjectDebugInformation[] = [];
    private startupProject: ProjectDebugInformation | undefined;
    private fallbackBuildProject: ProjectDebugInformation | undefined;

    public constructor(projects: ProjectDebugInformation[], private workspaceFolder: vscode.WorkspaceFolder) {
        this.vscodeFolder = path.join(this.workspaceFolder.uri.fsPath, '.vscode');
        this.tasksJsonPath = path.join(this.vscodeFolder, 'tasks.json');
        this.launchJsonPath = path.join(this.vscodeFolder, 'launch.json');

        if (projects !== undefined && projects.length > 0) {
            this.executableProjects = this.findExecutableMSBuildProjects(projects);
            if (this.executableProjects.length === 0) {
                this.fallbackBuildProject = projects[0];
            }
        }
    }

    public hasExecutableProjects(): boolean {
        return this.executableProjects.length > 0;
    }

    public isStartupProjectSelected(): boolean {
        return this.startupProject !== undefined;
    }

    public async selectStartupProject(selectedIndex?: number): Promise<boolean> {
        if (!this.hasExecutableProjects()) {
            throw new Error("No executable projects");
        }

        if (selectedIndex !== undefined) {
            this.startupProject = this.executableProjects[selectedIndex];
            return true;
        }

        if (this.executableProjects.length === 1) {
            this.startupProject = this.executableProjects[0];
            return true;
        } else {
            const items = this.executableProjects.map(project => ({
                label: project.projectName,
                project,
            }));

            const selectedItem = await vscode.window.showQuickPick(items, {
                matchOnDescription: true,
                placeHolder: "Select the project to launch"
            });

            if (selectedItem === undefined) {
                return false;
            }

            this.startupProject = selectedItem.project;
            return true;
        }
    }

    // This method is used by the unit tests instead of selectStartupProject
    public setStartupProject(index: number): void {
        if (index >= this.executableProjects.length) {
            throw new Error("Invalid project index");
        }

        this.startupProject = this.executableProjects[index];
    }

    public hasWebServerDependency(): boolean {
        if (!this.startupProject) {
            throw new Error("Startup project not set");
        }

        return this.startupProject.isWebProject;
    }

    public computeProgramLaunchType(): ProgramLaunchType {
        if (!this.startupProject) {
            throw new Error("Startup project not set");
        }

        if (this.startupProject.isBlazorWebAssemblyStandalone) {
            return ProgramLaunchType.BlazorWebAssemblyStandalone;
        }

        if (this.startupProject.isBlazorWebAssemblyHosted) {
            return ProgramLaunchType.BlazorWebAssemblyHosted;
        }

        if (this.startupProject.isWebProject) {
            return ProgramLaunchType.Web;
        }

        return ProgramLaunchType.Console;
    }

    private computeProgramPath(): string {
        if (!this.startupProject) {
            throw new Error("Startup project not set");
        }

        const relativeTargetPath = path.relative(this.workspaceFolder.uri.fsPath, this.startupProject.outputPath);
        if (relativeTargetPath === this.startupProject.outputPath) {
            // This can happen if, for example, the workspace folder and the target path
            // are on completely different drives.
            return this.startupProject.outputPath;
        }
        return path.join('${workspaceFolder}', relativeTargetPath);
    }

    private computeWorkingDirectory(): string {
        if (!this.startupProject) {
            throw new Error("Startup project not set");
        }

        // Startup project will always be a child of the workspace folder,
        // so the special check above isn't necessary.
        const relativeProjectPath = path.relative(this.workspaceFolder.uri.fsPath, this.startupProject.projectPath);
        return path.join('${workspaceFolder}', path.dirname(relativeProjectPath));
    }

    public createLaunchJsonConfigurationsArray(programLaunchType: ProgramLaunchType): vscode.DebugConfiguration[] {
        const launchJson: string = this.createLaunchJsonConfigurations(programLaunchType);

        const configurationArray: vscode.DebugConfiguration[] = JSON.parse(launchJson);

        // Remove comments
        configurationArray.forEach((configuration) => {
            for (const key in configuration) {
                if (Object.prototype.hasOwnProperty.call(configuration, key)) {
                    if (key.startsWith("OS-COMMENT")) {
                        delete configuration[key];
                    }
                }
            }
        });

        return configurationArray;
    }

    public createLaunchJsonConfigurations(programLaunchType: ProgramLaunchType): string {
        switch (programLaunchType) {
            case ProgramLaunchType.Console: {
                const launchConfigurationsMassaged: string = createLaunchConfiguration(this.computeProgramPath(), this.computeWorkingDirectory());
                const attachConfigurationsMassaged: string = createAttachConfiguration();
                return `
[
    ${launchConfigurationsMassaged},
    ${attachConfigurationsMassaged}
]`;
            }
            case ProgramLaunchType.Web: {
                const webLaunchConfigurationsMassaged: string = createWebLaunchConfiguration(this.computeProgramPath(), this.computeWorkingDirectory());
                const attachConfigurationsMassaged: string = createAttachConfiguration();
                return `
[
    ${webLaunchConfigurationsMassaged},
    ${attachConfigurationsMassaged}
]`;
            }
            case ProgramLaunchType.BlazorWebAssemblyHosted: {
                const hostedLaunchConfigMassaged: string = createBlazorWebAssemblyHostedLaunchConfiguration(this.computeProgramPath(), this.computeWorkingDirectory());
                return `
[
    ${hostedLaunchConfigMassaged}
]`;
            }
            case ProgramLaunchType.BlazorWebAssemblyStandalone: {
                const standaloneLaunchConfigMassaged: string = createBlazorWebAssemblyStandaloneLaunchConfiguration(this.computeWorkingDirectory());
                return `
[
    ${standaloneLaunchConfigMassaged}
]`;
            }
        }
    }

    private createBuildTaskDescription(): tasks.TaskDescription {
        let commandArgs = ['build'];

        this.AddAdditionalCommandArgs(commandArgs);

        return {
            label: 'build',
            command: 'dotnet',
            type: 'process',
            args: commandArgs,
            problemMatcher: '$msCompile'
        };
    }


    private createPublishTaskDescription(): tasks.TaskDescription {
        let commandArgs = ['publish'];

        this.AddAdditionalCommandArgs(commandArgs);

        return {
            label: 'publish',
            command: 'dotnet',
            type: 'process',
            args: commandArgs,
            problemMatcher: '$msCompile'
        };
    }

    private createWatchTaskDescription(): tasks.TaskDescription {
        let commandArgs = ['watch', 'run'];

        const buildProject = this.getBuildProjectPath();
        if (buildProject) {
            commandArgs.push('--project');
            commandArgs.push(buildProject);
        }

        // NOTE: Don't add any additional args, or this will disable hot reload. See:
        // https://github.com/dotnet/sdk/blob/957ae5ca599fdeaee425d23928d42da711373a5e/src/BuiltInTools/dotnet-watch/Program.cs#L247-L256

        return {
            label: 'watch',
            command: 'dotnet',
            type: 'process',
            args: commandArgs,
            problemMatcher: '$msCompile'
        };
    }

    private AddAdditionalCommandArgs(commandArgs: string[]) {
        const buildProject = this.getBuildProjectPath();
        if (buildProject) {
            commandArgs.push(buildProject);
        }

        commandArgs.push("/property:GenerateFullPaths=true");
        commandArgs.push("/consoleloggerparameters:NoSummary");
    }

    private getBuildProjectPath(): string | null {
        let buildProject = this.startupProject;
        if (!buildProject) {
            buildProject = this.fallbackBuildProject;
        }
        if (buildProject) {
            if (buildProject.solutionPath) {
                return this.getBuildPath(buildProject.solutionPath);
            }
            else {
                return this.getBuildPath(buildProject.projectPath);
            }
        }

        return null;
    }

    private getBuildPath(absoluteBuildPath: string) : string {
        const buildPath = path.join('${workspaceFolder}', path.relative(this.workspaceFolder.uri.fsPath, absoluteBuildPath));
        return util.convertNativePathToPosix(buildPath);
    }

    public createTasksConfiguration(): tasks.TaskConfiguration {
        return {
            version: "2.0.0",
            tasks: [this.createBuildTaskDescription(), this.createPublishTaskDescription(), this.createWatchTaskDescription()]
        };
    }

    private findExecutableMSBuildProjects(projects: ProjectDebugInformation[]) {
        let result: ProjectDebugInformation[] = [];
    
        projects.forEach(project => {
            const projectIsNotNetFramework = project.targetsDotnetCore || project.isBlazorWebAssemblyStandalone;
    
            if (project.isExe && projectIsNotNetFramework) {
                result.push(project);
            }
        });
    
        return result;
    }
}

export enum ProgramLaunchType {
    Console,
    Web,
    BlazorWebAssemblyHosted,
    BlazorWebAssemblyStandalone,
}

export function createWebLaunchConfiguration(programPath: string, workingDirectory: string): string {
    const configuration = {
        "OS-COMMENT1": "Use IntelliSense to find out which attributes exist for C# debugging",
        "OS-COMMENT2": "Use hover for the description of the existing attributes",
        "OS-COMMENT3": "For further information visit https://github.com/OmniSharp/omnisharp-vscode/blob/master/debugger-launchjson.md",
        "name": ".NET Core Launch (web)",
        "type": "coreclr",
        "request": "launch",
        "preLaunchTask": "build",
        "OS-COMMENT4": "If you have changed target frameworks, make sure to update the program path.",
        "program": `${util.convertNativePathToPosix(programPath)}`,
        "args": Array(0),
        "cwd": `${util.convertNativePathToPosix(workingDirectory)}`,
        "stopAtEntry": false,
        "OS-COMMENT5": "Enable launching a web browser when ASP.NET Core starts. For more information: https://aka.ms/VSCode-CS-LaunchJson-WebBrowser",
        "serverReadyAction": {
            "action": "openExternally",
            "pattern": "\\bNow listening on:\\s+(https?://\\S+)"
        },
        "env": {
            "ASPNETCORE_ENVIRONMENT": "Development"
        },
        "sourceFileMap": {
            "/Views": "\${workspaceFolder}/Views"
        }
    };

    return JSON.stringify(configuration);
}

export function createBlazorWebAssemblyHostedLaunchConfiguration(programPath: string, workingDirectory: string): string {
    const configuration = {
        "name": "Launch and Debug Hosted Blazor WebAssembly App",
        "type": "blazorwasm",
        "request": "launch",
        "hosted": true,
        "OS-COMMENT1": "If you have changed target frameworks, make sure to update the program path.",
        "program": `${util.convertNativePathToPosix(programPath)}`,
        "cwd": `${util.convertNativePathToPosix(workingDirectory)}`
    };

    return JSON.stringify(configuration);
}

export function createBlazorWebAssemblyStandaloneLaunchConfiguration(workingDirectory: string): string {
    const configuration = {
        "name": "Launch and Debug Standalone Blazor WebAssembly App",
        "type": "blazorwasm",
        "request": "launch",
        "cwd": `${util.convertNativePathToPosix(workingDirectory)}`
    };

    return JSON.stringify(configuration);
}

export function createLaunchConfiguration(programPath: string, workingDirectory: string): string {
    const configuration = {
        "OS-COMMENT1": "Use IntelliSense to find out which attributes exist for C# debugging",
        "OS-COMMENT2": "Use hover for the description of the existing attributes",
        "OS-COMMENT3": "For further information visit https://github.com/OmniSharp/omnisharp-vscode/blob/master/debugger-launchjson.md",
        "name": ".NET Core Launch (console)",
        "type": "coreclr",
        "request": "launch",
        "preLaunchTask": "build",
        "OS-COMMENT4": "If you have changed target frameworks, make sure to update the program path.",
        "program": `${util.convertNativePathToPosix(programPath)}`,
        "args": Array(0),
        "cwd": `${util.convertNativePathToPosix(workingDirectory)}`,
        "OS-COMMENT5": "For more information about the 'console' field, see https://aka.ms/VSCode-CS-LaunchJson-Console",
        "console": "internalConsole",
        "stopAtEntry": false
    };

    return JSON.stringify(configuration);
}

// DebugConfiguration written to launch.json when the extension fails to generate a good configuration
export function createFallbackLaunchConfiguration(): vscode.DebugConfiguration {
    return {
        "name": ".NET Core Launch (console)",
        "type": "coreclr",
        "request": "launch",
        "WARNING01": "*********************************************************************************",
        "WARNING02": "The C# extension was unable to automatically decode projects in the current",
        "WARNING03": "workspace to create a runnable launch.json file. A template launch.json file has",
        "WARNING04": "been created as a placeholder.",
        "WARNING05": "",
        "WARNING06": "If the server is currently unable to load your project, you can attempt to resolve",
        "WARNING07": "this by restoring any missing project dependencies (example: run 'dotnet restore')",
        "WARNING08": "and by fixing any reported errors from building the projects in your workspace.",
        "WARNING09": "If this allows the server to now load your project then --",
        "WARNING10": "  * Delete this file",
        "WARNING11": "  * Open the Visual Studio Code command palette (View->Command Palette)",
        "WARNING12": "  * run the command: '.NET: Generate Assets for Build and Debug'.",
        "WARNING13": "",
        "WARNING14": "If your project requires a more complex launch configuration, you may wish to delete",
        "WARNING15": "this configuration and pick a different template using the 'Add Configuration...'",
        "WARNING16": "button at the bottom of this file.",
        "WARNING17": "*********************************************************************************",
        "preLaunchTask": "build",
        "program": "${workspaceFolder}/bin/Debug/<insert-target-framework-here>/<insert-project-name-here>.dll",
        "args": [],
        "cwd": "${workspaceFolder}",
        "console": "internalConsole",
        "stopAtEntry": false
    };
}

// AttachConfiguration
export function createAttachConfiguration(): string {
    const configuration = {
        "name": ".NET Core Attach",
        "type": "coreclr",
        "request": "attach"
    };

    return JSON.stringify(configuration);
}

export interface AssetOperations {
    addTasksJson?: boolean;
    updateTasksJson?: boolean;
    addLaunchJson?: boolean;
}

function hasAddOperations(operations: AssetOperations) {
    return operations.addTasksJson || operations.addLaunchJson;
}

async function getOperations(generator: AssetGenerator): Promise<AssetOperations> {
    return getBuildOperations(generator).then(async operations =>
        getLaunchOperations(generator, operations));
}

/**
 * Finds a build task if there is one. Only handles new format.
 */
function getBuildTasks(tasksConfiguration: tasks.TaskConfiguration): tasks.TaskDescription[] {
    let result: tasks.TaskDescription[] = [];

    function findBuildTask(tasksDescriptions: tasks.TaskDescription[] | undefined) {
        let buildTask = undefined;
        if (tasksDescriptions !== undefined) {
            buildTask = tasksDescriptions.find(td => td.group === 'build');
        }

        if (buildTask !== undefined) {
            result.push(buildTask);
        }
    }

    findBuildTask(tasksConfiguration.tasks);

    if (tasksConfiguration.windows) {
        findBuildTask(tasksConfiguration.windows.tasks);
    }

    if (tasksConfiguration.osx) {
        findBuildTask(tasksConfiguration.osx.tasks);
    }

    if (tasksConfiguration.linux) {
        findBuildTask(tasksConfiguration.linux.tasks);
    }

    return result;
}

export async function getBuildOperations(generator: AssetGenerator): Promise<AssetOperations> {
    return new Promise<AssetOperations>((resolve, reject) => {
        fs.exists(generator.tasksJsonPath, exists => {
            if (exists) {
                fs.readFile(generator.tasksJsonPath, (err, buffer) => {
                    if (err) {
                        return reject(err);
                    }

                    const text = buffer.toString();
                    let tasksConfiguration: tasks.TaskConfiguration;

                    try {
                        tasksConfiguration = tolerantParse(text);
                    }
                    catch (error) {
                        vscode.window.showErrorMessage(`Failed to parse tasks.json file`);
                        return resolve({ updateTasksJson: false });
                    }

                    if (!tasksConfiguration.version || !tasksConfiguration.version.startsWith("2.0.")) {
                        // We don't have code to update the older tasks format, so don't try to update it
                        return resolve({ updateTasksJson: false });
                    }

                    let buildTasks = getBuildTasks(tasksConfiguration);

                    resolve({ updateTasksJson: buildTasks.length === 0 });
                });
            }
            else {
                resolve({ addTasksJson: true });
            }
        });
    });
}

async function getLaunchOperations(generator: AssetGenerator, operations: AssetOperations): Promise<AssetOperations> {

    if (!generator.hasExecutableProjects()) {
        return Promise.resolve(operations);
    }

    return new Promise<AssetOperations>((resolve, reject) => {
        return fs.exists(generator.launchJsonPath, exists => {
            if (exists) {
                resolve(operations);
            }
            else {
                operations.addLaunchJson = true;
                resolve(operations);
            }
        });
    });
}

enum PromptResult {
    Yes,
    No,
    Disable
}

interface PromptItem extends vscode.MessageItem {
    result: PromptResult;
}

async function promptToAddAssets(workspaceFolder: vscode.WorkspaceFolder) {
    return new Promise<PromptResult>((resolve, reject) => {
        const yesItem: PromptItem = { title: 'Yes', result: PromptResult.Yes };
        const noItem: PromptItem = { title: 'Not Now', result: PromptResult.No, isCloseAffordance: true };
        const disableItem: PromptItem = { title: "Don't Ask Again", result: PromptResult.Disable };

        const projectName = path.basename(workspaceFolder.uri.fsPath);

        if (!getBuildAssetsNotificationSetting()) {
            vscode.window.showWarningMessage(
                `Required assets to build and debug are missing from '${projectName}'. Add them?`, disableItem, noItem, yesItem)
                .then(selection => resolve(selection?.result ?? PromptResult.No));
        }
    });
}

function getBuildAssetsNotificationSetting() {
    const newSettingName: string = 'suppressBuildAssetsNotification';
    let csharpConfig = vscode.workspace.getConfiguration('csharp');
    if (csharpConfig.has(newSettingName)) {
        return csharpConfig.get<boolean>(newSettingName);
    }

    return csharpConfig.get<boolean>('supressBuildAssetsNotification');
}

export function getFormattingOptions(): FormattingOptions {
    const editorConfig = vscode.workspace.getConfiguration('editor');

    const tabSize = editorConfig.get<number>('tabSize') ?? 4;
    const insertSpaces = editorConfig.get<boolean>('insertSpaces') ?? true;

    const filesConfig = vscode.workspace.getConfiguration('files');
    const eolSetting = filesConfig.get<string>('eol');
    const eol = !eolSetting || eolSetting === 'auto' ? os.EOL : '\n';

    const formattingOptions: FormattingOptions = {
        insertSpaces: insertSpaces,
        tabSize: tabSize,
        eol: eol
    };

    return formattingOptions;
}

export async function addTasksJsonIfNecessary(generator: AssetGenerator, operations: AssetOperations) {
    return new Promise<void>((resolve, reject) => {
        if (!operations.addTasksJson && !operations.updateTasksJson) {
            return resolve();
        }

        const formattingOptions = getFormattingOptions();

        const tasksJson = generator.createTasksConfiguration();

        let text: string;
        if (!fs.pathExistsSync(generator.tasksJsonPath)) {
            // when tasks.json does not exist create it and write all the content directly
            const tasksJsonText = JSON.stringify(tasksJson);
            const tasksJsonTextFormatted = jsonc.applyEdits(tasksJsonText, jsonc.format(tasksJsonText, undefined, formattingOptions));
            text = tasksJsonTextFormatted;
        }
        else {
            // when tasks.json exists just update the tasks node
            const ourConfigs = tasksJson.tasks ?? [];
            const content = fs.readFileSync(generator.tasksJsonPath, { encoding: 'utf8' });
            const updatedJson = updateJsonWithComments(content, ourConfigs, 'tasks', 'label', formattingOptions);
            text = updatedJson;
        }

        const tasksJsonTextCommented = replaceCommentPropertiesWithComments(text);
        fs.writeFile(generator.tasksJsonPath, tasksJsonTextCommented, err => {
            if (err) {
                return reject(err);
            }

            resolve();
        });
    });
}

async function addLaunchJsonIfNecessary(generator: AssetGenerator, operations: AssetOperations) {
    return new Promise<void>((resolve, reject) => {
        if (!operations.addLaunchJson) {
            return resolve();
        }

        const programLaunchType = generator.computeProgramLaunchType();
        const launchJsonConfigurations: string = generator.createLaunchJsonConfigurations(programLaunchType);
        const formattingOptions = getFormattingOptions();

        let text: string;
        if (!fs.pathExistsSync(generator.launchJsonPath)) {
            // when launch.json does not exist, create it and write all the content directly
            const configurationsMassaged: string = launchJsonConfigurations;
            const launchJsonText = `
            {
                "version": "0.2.0",
                "configurations": ${configurationsMassaged}
            }`;

            text = jsonc.applyEdits(launchJsonText, jsonc.format(launchJsonText, undefined, formattingOptions));
        }
        else {
            // when launch.json exists replace or append our configurations
            const ourConfigs = jsonc.parse(launchJsonConfigurations) ?? [];
            const content = fs.readFileSync(generator.launchJsonPath, { encoding: 'utf8' });
            const updatedJson = updateJsonWithComments(content, ourConfigs, 'configurations', 'name', formattingOptions);
            text = updatedJson;
        }

        const textWithComments = replaceCommentPropertiesWithComments(text);
        fs.writeFile(generator.launchJsonPath, textWithComments, err => {
            if (err) {
                return reject(err);
            }

            resolve();
        });
    });
}

async function addAssets(generator: AssetGenerator, operations: AssetOperations) {

    if (generator.hasExecutableProjects() && !generator.isStartupProjectSelected()) {
        if (!await generator.selectStartupProject()) {
            return;
        }
    }

    const promises = [
        addTasksJsonIfNecessary(generator, operations),
        addLaunchJsonIfNecessary(generator, operations)
    ];

    return Promise.all(promises);
}

export enum AddAssetResult {
    NotApplicable,
    Done,
    Disable,
    Cancelled
}

export async function addAssetsIfNecessary(context: vscode.ExtensionContext, workspaceInformationProvider: IWorkspaceDebugInformationProvider): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
        return;
    }

    if (context.workspaceState.get<boolean>('assetPromptDisabled')) {
        return;
    }

    let generationResults = vscode.workspace.workspaceFolders.map(async (workspaceFolder) => 
    {
        const info = await workspaceInformationProvider.getWorkspaceDebugInformation(workspaceFolder.uri);
        if (!info || info.length === 0) {
            return AddAssetResult.NotApplicable;
        }

        const generator = new AssetGenerator(info, workspaceFolder);
        // If there aren't executable projects, we will not prompt
        if (generator.hasExecutableProjects()) {
            const operations = await getOperations(generator);
            if (!hasAddOperations(operations)) {
                return AddAssetResult.NotApplicable;
            }

            const result = await promptToAddAssets(workspaceFolder);
            if (result === PromptResult.Disable) {
                return AddAssetResult.Disable;
            }

            if (result !== PromptResult.Yes) {
                return AddAssetResult.Cancelled;
            }

            await fs.ensureDir(generator.vscodeFolder);
            await addAssets(generator, operations);
            return AddAssetResult.Done;
        }

        return AddAssetResult.NotApplicable;
    });

    const results = await Promise.all(generationResults);
    // If prompts were disabled, store it in workspace state so we don't ask again during this session.
    if (results.some(r => r === AddAssetResult.Disable)) {
        context.workspaceState.update('assetPromptDisabled', true);
    }
}

async function getExistingAssets(generator: AssetGenerator) {
    return new Promise<string[]>((resolve, reject) => {
        let assets: string[] = [];
        if (fs.pathExistsSync(generator.tasksJsonPath)) {
            const content = fs.readFileSync(generator.tasksJsonPath).toString();
            let taskLabels = ["build", "publish", "watch"];
            const tasks = jsonc.parse(content)?.tasks?.
                map((t: { label: string; }) => t.label).
                filter((l: string) => taskLabels.includes(l));

            assets = assets.concat(tasks);
        }

        if (fs.pathExistsSync(generator.launchJsonPath)) {
            const content = fs.readFileSync(generator.launchJsonPath).toString();
            let configurationNames = [
                ".NET Core Launch (console)",
                ".NET Core Launch (web)",
                ".NET Core Attach",
                "Launch and Debug Standalone Blazor WebAssembly App",
            ];
            const configurations = jsonc.parse(content)?.configurations?.
                map((t: { name: string; }) => t.name).
                filter((n: string) => configurationNames.includes(n));

            assets = assets.concat(configurations);
        }

        resolve(assets);
    });
}

async function shouldGenerateAssets(generator: AssetGenerator): Promise<Boolean> {
    return new Promise<Boolean>((resolve, reject) => {
        getExistingAssets(generator).then(res => {
            if (res.length > 0) {
                const yesItem = { title: 'Yes' };
                const cancelItem = { title: 'Cancel', isCloseAffordance: true };
                vscode.window.showWarningMessage('Replace existing build and debug assets?', cancelItem, yesItem)
                    .then(selection => {
                        if (selection === yesItem) {
                            resolve(true);
                        }
                        else {
                            // The user clicked cancel
                            resolve(false);
                        }
                    });
            }
            else {
                // The assets don't exist, so we're good to go.
                resolve(true);
            }
        });

    });
}

export async function generateAssets(workspaceInformationProvider: IWorkspaceDebugInformationProvider, selectedIndex?: number): Promise<void> {
    try {
        if (!vscode.workspace.workspaceFolders) {
            return;
        }

        for(let workspaceFolder of vscode.workspace.workspaceFolders) {
            let workspaceInformation = await workspaceInformationProvider.getWorkspaceDebugInformation(workspaceFolder.uri);
            if (workspaceInformation && workspaceInformation.length > 0) {
                // Currently the server only runs in a single workspace.  So we can just find the workspace folder from any of the projects.
                const resourcePath = workspaceInformation[0].projectPath;
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(resourcePath));
                if (workspaceFolder === undefined) {
                    return;
                }
    
                const generator = new AssetGenerator(workspaceInformation, workspaceFolder);
                let doGenerateAssets = await shouldGenerateAssets(generator);
                if (!doGenerateAssets) {
                    return; // user cancelled
                }
    
                const operations: AssetOperations = {
                    addLaunchJson: generator.hasExecutableProjects(),
                    addTasksJson: true
                };
    
                if (operations.addLaunchJson) {
                    if (!await generator.selectStartupProject(selectedIndex)) {
                        return; // user cancelled
                    }
                }
    
                await fs.ensureDir(generator.vscodeFolder);
                await addAssets(generator, operations);
            }
            else {
                await vscode.window.showErrorMessage(`Could not locate .NET Core project in ${workspaceFolder.name}. Assets were not generated.`);
            }
        }
    }
    catch (err) {
        await vscode.window.showErrorMessage(`Unable to generate assets to build and debug. ${err}`);
    }
}

export function replaceCommentPropertiesWithComments(text: string) {
    // replacing dummy properties OS-COMMENT with the normal comment syntax
    let regex = /["']OS-COMMENT\d*["']\s*\:\s*["'](.*)["']\s*?,/gi;
    let withComments = text.replace(regex, '// $1');

    return withComments;
}

export function updateJsonWithComments(text: string, replacements: any[], nodeName: string, keyName: string, formattingOptions: FormattingOptions): string {
    let modificationOptions: ModificationOptions = {
        formattingOptions
    };

    // parse using jsonc because there are comments
    // only use this to determine what to change
    // we will modify it as text to keep existing comments
    let parsed = jsonc.parse(text);
    let items = parsed[nodeName];
    let itemKeys: string[] = items.map((i: { [x: string]: string; }) => i[keyName]);

    let modified = text;
    // count how many items we inserted to ensure we are putting items at the end
    // in the same order as they are in the replacements array
    let insertCount = 0;
    replacements.map((replacement: { [x: string]: string; }) => {
        let index = itemKeys.indexOf(replacement[keyName]);

        let found = index >= 0;
        let modificationIndex = found ? index : items.length + insertCount++;
        let edits = jsonc.modify(modified, [nodeName, modificationIndex], replacement, modificationOptions);
        let updated = jsonc.applyEdits(modified, edits);

        // we need to carry out the changes one by one, because we are inserting into the json
        // and so we cannot just figure out all the edits from the original text, instead we need to apply
        // changes one by one
        modified = updated;
    });

    return replaceCommentPropertiesWithComments(modified);
}
