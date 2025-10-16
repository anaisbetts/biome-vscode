import {
	type TextDocumentChangeEvent,
	Uri,
	type WorkspaceFolder,
	window,
} from "vscode";
import {
	CloseAction,
	type CloseHandlerResult,
	type DocumentFilter,
	ErrorAction,
	type ErrorHandler,
	type ErrorHandlerResult,
	type InitializeParams,
	LanguageClient,
	type LanguageClientOptions,
	type Message,
	type Middleware,
	type ServerOptions,
	TransportKind,
} from "vscode-languageclient/node";
import { displayName } from "../package.json";
import type Biome from "./biome";
import { supportedLanguages } from "./constants";

export default class Session {
	/**
	 * The language client for this session.
	 */
	private client: LanguageClient | undefined;

	public get biomeVersion(): string | undefined {
		return this.client?.initializeResult?.serverInfo?.version;
	}

	/**
	 * Creates a new LSP session
	 */
	public constructor(
		private readonly biome: Biome,
		public readonly bin: Uri,
		private readonly folder?: WorkspaceFolder,
		private readonly singleFileFolder?: Uri,
	) {}

	public static createForWorkspaceFolder(
		biome: Biome,
		bin: Uri,
		workspaceFolder: WorkspaceFolder,
	): Session {
		return new Session(biome, bin, workspaceFolder);
	}

	public static createForSingleFile(
		biome: Biome,
		bin: Uri,
		singleFileFolder: Uri,
	): Session {
		return new Session(biome, bin, undefined, singleFileFolder);
	}

	public static createForGlobalInstance(biome: Biome, bin: Uri): Session {
		return new Session(biome, bin);
	}

	/**
	 * Starts the LSP session.
	 */
	public async start() {
		this.client = this.createLanguageClient();
		await this.client.start();
	}

	/**
	 * Stops the LSP session.
	 */
	public async stop() {
		this.biome.logger.debug("Stopping LSP session");

		await this.client?.stop();

		this.biome.logger.debug("LSP session stopped");

		this.client = undefined;
	}

	/**
	 * Creates a new language client for the session.
	 */
	private createLanguageClient(): LanguageClient {
		this.biome.logger.debug(
			`Creating LSP session for ${this.folder?.name ?? "global"} with ${this.bin.fsPath}`,
		);

		const serverOptions: ServerOptions = {
			command: this.bin.fsPath,
			transport: TransportKind.stdio,
			args: ["lsp-proxy"],
		};

		const outputChannel = window.createOutputChannel(
			`${displayName} (${this.folder?.name ?? "global"}) - LSP`,
			{ log: true },
		);

		const clientOptions: LanguageClientOptions = {
			outputChannel: outputChannel,
			traceOutputChannel: outputChannel,
			documentSelector: this.createDocumentSelector(),
			workspaceFolder: this.folder,
			initializationOptions: {
				...(this.singleFileFolder && {
					rootUri: this.singleFileFolder,
				}),
			},
			// Custom error handler to gracefully handle server crashes and EPIPE errors
			errorHandler: new BiomeErrorHandler(this.biome),
			// Connection options to control restart behavior
			connectionOptions: {
				maxRestartCount: 5,
			},
			// Middleware to de-duplicate rapid changes to the same document
			middleware: new BiomeMiddleware(this.biome),
		};

		return new BiomeLanguageClient(
			"biome.lsp",
			"biome",
			serverOptions,
			clientOptions,
		);
	}

	/**
	 * Creates the document selector for the language client.
	 */
	private createDocumentSelector(): DocumentFilter[] {
		const folder = this.folder;
		const singleFileFolder = this.singleFileFolder;

		if (folder !== undefined) {
			return supportedLanguages.map((language) => ({
				language,
				scheme: "file",
				pattern: Uri.joinPath(folder.uri, "**", "*").fsPath.replaceAll(
					"\\",
					"/",
				),
			}));
		} else if (singleFileFolder !== undefined) {
			return supportedLanguages.map((language) => ({
				language,
				scheme: "file",
				pattern: Uri.joinPath(singleFileFolder, "**", "*").fsPath.replaceAll(
					"\\",
					"/",
				),
			}));
		}

		return supportedLanguages.flatMap((language) => {
			return ["untitled", "vscode-userdata"].map((scheme) => ({
				language,
				scheme,
			}));
		});
	}
}

/**
 * Middleware to de-duplicate rapid document changes.
 *
 * When files are edited rapidly (e.g., by an LLM agent), the default behavior
 * sends every single change immediately. This middleware de-duplicates changes
 * to the same document by only sending the final state after edits have settled.
 *
 * This reduces the total number of LSP notifications when a document is edited
 * multiple times in quick succession, preventing the stdio pipe from being
 * overwhelmed and causing EPIPE errors.
 */
class BiomeMiddleware implements Middleware {
	private pendingChanges = new Map<
		string,
		{ event: TextDocumentChangeEvent; timeout: NodeJS.Timeout }
	>();

	constructor(private readonly biome: Biome) {}

	/**
	 * Intercepts textDocument/didChange notifications and de-duplicates them.
	 *
	 * When multiple rapid changes occur to the same document, this discards
	 * intermediate states and only sends the final state after a brief delay.
	 *
	 * Example: 10 rapid edits to file.ts in 100ms → Only 1 notification sent
	 */
	didChange(
		event: TextDocumentChangeEvent,
		next: (event: TextDocumentChangeEvent) => Promise<void>,
	): Promise<void> {
		const uri = event.document.uri.toString();

		// Clear any pending notification for this document
		// This discards intermediate states when rapid edits occur
		const pending = this.pendingChanges.get(uri);
		if (pending) {
			clearTimeout(pending.timeout);
		}

		// Schedule the change to be sent after a brief delay (50ms)
		// If more changes arrive before the delay expires, this will be cancelled
		const timeout = setTimeout(() => {
			this.pendingChanges.delete(uri);
			this.biome.logger.debug(`Dispatching didChange for ${event.document.uri.fsPath}`);
			next(event);
		}, 50);

		this.pendingChanges.set(uri, { event, timeout });

		// Return immediately - the actual notification will be sent after the delay
		return Promise.resolve();
	}
}

/**
 * Custom error handler for the Biome language server.
 *
 * This error handler gracefully handles server crashes and EPIPE errors
 * that can occur when files are edited rapidly (e.g., by an LLM agent).
 * It prevents the extension from attempting to write to a destroyed stream
 * and provides better logging and error recovery.
 */
class BiomeErrorHandler implements ErrorHandler {
	constructor(private readonly biome: Biome) {}

	/**
	 * Handles errors that occur during communication with the server.
	 *
	 * @param error The error that occurred
	 * @param _message The message that was being sent when the error occurred
	 * @param count The number of errors that have occurred
	 * @returns The action to take in response to the error
	 */
	error(error: Error, _message: Message | undefined, count: number | undefined): ErrorHandlerResult | Promise<ErrorHandlerResult> {
		// Log the error for debugging
		this.biome.logger.error(`LSP error (count: ${count}): ${error.message}`);

		// For EPIPE errors (broken pipe), the server has already crashed
		// Don't try to continue - shutdown gracefully
		if (
			error.message.includes("EPIPE") ||
			error.message.includes("stream was destroyed")
		) {
			this.biome.logger.error(
				"Server connection lost (EPIPE). Shutting down client.",
			);
			return { action: ErrorAction.Shutdown };
		}

		// For other errors, retry up to 5 times
		if ((count ?? 0) < 5) {
			this.biome.logger.info(`Retrying after error (attempt ${(count ?? 0) + 1}/5)`);
			return { action: ErrorAction.Continue };
		}

		// After 5 errors, give up and shutdown
		this.biome.logger.error("Too many errors occurred. Shutting down client.");
		return { action: ErrorAction.Shutdown };
	}

	/**
	 * Handles the case where the server closes the connection.
	 *
	 * @returns The action to take when the server closes
	 */
	closed(): CloseHandlerResult | Promise<CloseHandlerResult> {
		this.biome.logger.warn("Server connection closed");
		// Don't restart automatically - let the extension handle it
		return { action: CloseAction.DoNotRestart };
	}
}

class BiomeLanguageClient extends LanguageClient {
	protected fillInitializeParams(params: InitializeParams): void {
		super.fillInitializeParams(params);

		if (params.initializationOptions?.rootUri) {
			params.rootUri = params.initializationOptions?.rootUri.toString();
		}

		if (params.initializationOptions?.rootPath) {
			params.rootPath = params.initializationOptions?.rootPath;
		}
	}
}
