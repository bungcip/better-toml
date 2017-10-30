declare module "ct" {
    export interface IRecognizerContext {
        /**
         * A copy of the parser's rule stack at the "time" the RecognitionException occurred.
         * This can be used to help debug parsing errors (How did we get here?).
         */
        ruleStack: string[]

        /**
         * A copy of the parser's rule occurrence stack at the "time" the RecognitionException occurred.
         * This can be used to help debug parsing errors (How did we get here?).
         */
        ruleOccurrenceStack: number[]
    }

    export interface IRecognitionException {
        name: string
        message: string
        /**
         * The token which caused the parser error.
         */
        token: Token
        /**
         * Additional tokens which have been re-synced in error recovery due to the original error.
         * This information can be used the calculate the whole text area which has been skipped due to an error.
         * For example for displaying with a red underline in a text editor.
         */
        resyncedTokens: Token[]

        context: IRecognizerContext
    }

    export interface ILexingError {
        offset: number
        line: number
        column: number
        length: number
        message: string
    }

    export interface Token {
        
    }

}