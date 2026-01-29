import { ContextManager } from "@src/context-manager.mjs";
import { TemplateProcessor } from "@src/templates/templateprocessor.mjs";
export interface IApplication {
    name: string;
    description: string;
    installation?: string[];
    backup?: string[];
    restore?: string[];
    uninstall?: string[];
    update?: string[];
    upgrade?: string[];
}
export interface IParameter {
    id: string;
    name: string;
    type: "enum" | "string" | "number" | "boolean";
    enumValues?: string[];
    description?: string;
    default?: string | number | boolean;
    required?: boolean;
    value?: string | number | boolean;
}
export interface ICommand {
    execute_on?: "ve" | "lxc";
    command?: string;
    script?: string;
    template?: string;
    name?: string;
    description?: string;
}
export interface ITemplate {
    execute_on: "ve" | "lxc";
    name: string;
    description?: string;
    parameters?: IParameter[];
    commands: ICommand[];
    outputs?: string[];
}
export declare class VeTestHelper {
    tempDir: string;
    jsonDir: string;
    schemaDir: string;
    localDir: string;
    setup(): Promise<void>;
    cleanup(): Promise<void>;
    getApplicationNames(): string[];
    readApplication(appName: string): IApplication;
    writeApplication(appName: string, data: IApplication): void;
    getTemplateNames(appName: string): string[];
    readTemplate(appName: string, tmplName: string): ITemplate;
    writeTemplate(appName: string, tmplName: string, data: ITemplate): void;
    writeScript(appName: string, scriptName: string, content: string): void;
    createStorageContext(): ContextManager;
    createTemplateProcessor(): TemplateProcessor;
}
//# sourceMappingURL=ve-test-helper.d.mts.map