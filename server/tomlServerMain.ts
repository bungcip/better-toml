/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
    IPCMessageReader, IPCMessageWriter,
	createConnection, IConnection,
	TextDocuments, TextDocument, InitializeParams, InitializeResult, NotificationType, RequestType,
    DiagnosticSeverity, Diagnostic
} from 'vscode-languageserver';

import { xhr, XHRResponse, configure as configureHttpRequests, getErrorStatusDescription } from 'request-light';
import path = require('path');
import fs = require('fs');
import URI from './utils/uri';
import * as URL from 'url';
import Strings = require('./utils/strings');
import { JSONDocument, JSONSchema, LanguageSettings, LanguageServiceParams, LanguageService, getLanguageService } from 'vscode-json-languageservice';
// import { CargoTOMLContribution } from './tomlcontributions/cargoTOMLContribution';
// import { ProjectJSONContribution } from './jsoncontributions/projectJSONContribution';
// import { GlobPatternContribution } from './jsoncontributions/globPatternContribution';
import { FileAssociationContribution } from './jsoncontributions/fileAssociationContribution';
import { getLanguageModelCache } from './languageModelCache';

import * as bombadil from '@sgarciac/bombadil';
import * as ct from 'ct';

interface ISchemaAssociations {
	[pattern: string]: string[];
}

namespace SchemaAssociationNotification {
	export const type: NotificationType<ISchemaAssociations, any> = new NotificationType('json/schemaAssociations');
}

namespace VSCodeContentRequest {
	export const type: RequestType<string, string, any, any> = new RequestType('vscode/content');
}


// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

console.log = connection.console.log.bind(connection.console);
console.error = connection.console.error.bind(connection.console);

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

const filesAssociationContribution = new FileAssociationContribution();

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
let workspaceRoot: URI;
connection.onInitialize((params: InitializeParams): InitializeResult => {
	workspaceRoot = URI.parse(params.rootPath);
	if (params.initializationOptions) {
		filesAssociationContribution.setLanguageIds(params.initializationOptions.languageIds);
	}
	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: documents.syncKind,
			completionProvider: { resolveProvider: true, triggerCharacters: ['"', '='] },
			hoverProvider: true,
			documentSymbolProvider: true,
			// documentRangeFormattingProvider: !params.initializationOptions || params.initializationOptions['format.enable']
		}
	};
});

let workspaceContext = {
	resolveRelativePath: (relativePath: string, resource: string) => {
		return URL.resolve(resource, relativePath);
	}
};

let schemaRequestService = (uri: string): Thenable<string> => {
	if (Strings.startsWith(uri, 'file://')) {
		let fsPath = URI.parse(uri).fsPath;
		return new Promise<string>((c, e) => {
			fs.readFile(fsPath, 'UTF-8', (err, result) => {
				err ? e('') : c(result.toString());
			});
		});
	} else if (Strings.startsWith(uri, 'vscode://')) {
		return connection.sendRequest(VSCodeContentRequest.type, uri).then(responseText => {
			return responseText;
		}, error => {
			return error.message;
		});
	}
	if (uri.indexOf('//schema.management.azure.com/') !== -1) {
		connection.telemetry.logEvent({
			key: 'json.schema',
			value: {
				schemaURL: uri
			}
		});
	}
	return xhr({ url: uri, followRedirects: 5 }).then(response => {
		return response.responseText;
	}, (error: XHRResponse) => {
		return Promise.reject(error.responseText || getErrorStatusDescription(error.status) || error.toString());
	});
};


type TOMLDocument = {
    json: Object,
	errors: [bombadil.TomlError]
};

interface TomlLanguageService extends LanguageService {
    parseTOMLDocument(document: TextDocument): TOMLDocument; 
    doValidation(textDocument: TextDocument, tomlDocument: TOMLDocument): Thenable<Diagnostic[]>;
}

/// parse TOML for vs code text
function parseTOML(input: string): TOMLDocument {
    let tomlDocument = {};

		let reader = new bombadil.TomlReader;
		reader.readToml(input);

	if(reader.result != null){
        tomlDocument['json'] = reader.result;
        tomlDocument['errors'] = [];
    }else{
        tomlDocument['json'] = {};
        tomlDocument['errors'] = reader.errors;
    }

    return tomlDocument as TOMLDocument;
}

/// helper function to get language service
function getTomlLanguageService(params: LanguageServiceParams): TomlLanguageService {
    /// setup toml ls
    let jsonLs = getLanguageService(params);
	let tomlLs = Object.assign({}, jsonLs, {
        parseTOMLDocument: (document: TextDocument) => parseTOML(document.getText()),
		doValidation: (textDocument: TextDocument, tomlDocument: TOMLDocument) => {
            let diagnostics = [];

            /// validate toml first
            if(tomlDocument.errors.length > 0){
				let ex = tomlDocument.errors[0];
				let start = {line: 0, column: 0};
				let end = {line:0, column: 1};
				let message = ex.message;

				if(ex.hasOwnProperty('line')){
					// toml parser give position in one based, but languageserver used zero based
					// so we must convert it before send the position
					start = {line: ex['line'] - 1, column: ex['column'] - 1};
					end = {line: ex['line'] - 1, column: ex['column'] + ex['length']};
				}else if (ex.hasOwnProperty('token')){
					let token = ex['token'];
					start = {line: token.line - 1, column: token.column - 1};
					end = {line: token.line - 1, column: token.column - 1 + token.length};
				}else {

				}

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: {start, end},
					message: message,
					source: 'Toml Parser'
				});


                return Promise.resolve(diagnostics);
			}
			
			return Promise.resolve();

            // /// convert to json string because we want to use json schema validation...
            // /// basically we convert TOML -> JS Object -> JSON String -> JSON AST
            // let jsonString = JSON.stringify(tomlDocument.json);
            // let facade = {
            //     getText: () => jsonString
            // };
            // let jsonDocument = jsonLs.parseJSONDocument(facade as TextDocument);

            // return jsonLs.doValidation(textDocument, jsonDocument);
        },
	});
    
    return tomlLs;
}

// create the JSON language service
let languageService = getTomlLanguageService({
	schemaRequestService,
	workspaceContext,
	contributions: [
		// new ProjectJSONContribution(),
		// new GlobPatternContribution(),
		// filesAssociationContribution
		// new CargoTOMLContribution()
	]
});

// The settings interface describes the server relevant settings part
interface Settings {
	toml: {
		schemas: JSONSchemaSettings[];
	};
	http: {
		proxy: string;
		proxyStrictSSL: boolean;
	};
}

interface JSONSchemaSettings {
	fileMatch?: string[];
	url?: string;
	schema?: JSONSchema;
}

let tomlConfigurationSettings: JSONSchemaSettings[] = void 0;
let schemaAssociations: ISchemaAssociations = void 0;

// The settings have changed. Is send on server activation as well.
connection.onDidChangeConfiguration((change) => {
	var settings = <Settings>change.settings;
	configureHttpRequests(settings.http && settings.http.proxy, settings.http && settings.http.proxyStrictSSL);

	tomlConfigurationSettings = settings.toml && settings.toml.schemas;
	updateConfiguration();
});

// The jsonValidation extension configuration has changed
connection.onNotification(SchemaAssociationNotification.type, associations => {
	schemaAssociations = associations;
	updateConfiguration();
});

function updateConfiguration() {
	let languageSettings: LanguageSettings = {
		validate: true,
		allowComments: true,
		schemas: []
	};
	if (schemaAssociations) {
		for (var pattern in schemaAssociations) {
			let association = schemaAssociations[pattern];
			if (Array.isArray(association)) {
				association.forEach(uri => {
					languageSettings.schemas.push({ uri, fileMatch: [pattern] });
				});
			}
		}
	}
	if (tomlConfigurationSettings) {
		tomlConfigurationSettings.forEach(schema => {
			let uri = schema.url;
			if (!uri && schema.schema) {
				uri = schema.schema.id;
			}
			if (!uri && schema.fileMatch) {
				uri = 'vscode://schemas/custom/' + encodeURIComponent(schema.fileMatch.join('&'));
			}
			if (uri) {
				if (uri[0] === '.' && workspaceRoot) {
					// workspace relative path
					uri = URI.file(path.normalize(path.join(workspaceRoot.fsPath, uri))).toString();
				}
				languageSettings.schemas.push({ uri, fileMatch: schema.fileMatch, schema: schema.schema });
			}
		});
	}
	languageService.configure(languageSettings);

	// Revalidate any open text documents
	documents.all().forEach(triggerValidation);
}

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
	triggerValidation(change.document);
});

// a document has closed: clear all diagnostics
documents.onDidClose(event => {
	cleanPendingValidation(event.document);
	connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

let pendingValidationRequests: { [uri: string]: NodeJS.Timer; } = {};
const validationDelayMs = 200;

function cleanPendingValidation(textDocument: TextDocument): void {
	let request = pendingValidationRequests[textDocument.uri];
	if (request) {
		clearTimeout(request);
		delete pendingValidationRequests[textDocument.uri];
	}
}

function triggerValidation(textDocument: TextDocument): void {
	cleanPendingValidation(textDocument);
	pendingValidationRequests[textDocument.uri] = setTimeout(() => {
		delete pendingValidationRequests[textDocument.uri];
		validateTextDocument(textDocument);
	}, validationDelayMs);
}

function validateTextDocument(textDocument: TextDocument): void {
	if (textDocument.getText().length === 0) {
		// ignore empty documents
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
		return;
	}

	let tomlDocument = getTOMLDocument(textDocument);
	languageService.doValidation(textDocument, tomlDocument).then(diagnostics => {
		// Send the computed diagnostics to VSCode.
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
	});
}

connection.onDidChangeWatchedFiles((change) => {
	// Monitored files have changed in VSCode
	let hasChanges = false;
	change.changes.forEach(c => {
		if (languageService.resetSchema(c.uri)) {
			hasChanges = true;
		}
	});
	if (hasChanges) {
		documents.all().forEach(validateTextDocument);
	}
});

let tomlDocuments = getLanguageModelCache<TOMLDocument>(10, 60, document => languageService.parseTOMLDocument(document));

/// TOML
function getTOMLDocument(document: TextDocument): TOMLDocument {
	return tomlDocuments.get(document);
}

connection.onCompletion(textDocumentPosition => {
	let document = documents.get(textDocumentPosition.textDocument.uri);
	let tomlDocument = getTOMLDocument(document);
	return languageService.doComplete(document, textDocumentPosition.position, tomlDocument);
});

connection.onCompletionResolve(completionItem => {
	return languageService.doResolve(completionItem);
});

connection.onHover(textDocumentPositionParams => {
	let document = documents.get(textDocumentPositionParams.textDocument.uri);
	let tomlDocument = getTOMLDocument(document);
	return languageService.doHover(document, textDocumentPositionParams.position, tomlDocument);
});

connection.onDocumentSymbol(documentSymbolParams => {
	let document = documents.get(documentSymbolParams.textDocument.uri);
	let tomlDocument = getTOMLDocument(document);
	return languageService.findDocumentSymbols(document, tomlDocument);
});

connection.onDocumentRangeFormatting(formatParams => {
	let document = documents.get(formatParams.textDocument.uri);
	return languageService.format(document, formatParams.range, formatParams.options);
});

// Listen on the connection
connection.listen();