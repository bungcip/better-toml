/// toml node 
declare module "toml" {
    export function parse(input: string) : Object;

    export interface TomlSyntaxError extends SyntaxError {
        line: number;
        column: number;
        offset: number;
        expected: Object;
        found: Object;
    }
}
