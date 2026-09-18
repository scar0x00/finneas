import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import type {
    CallToolResult,
    TextContent,
    Tool,
} from "@modelcontextprotocol/sdk/types";

/**
 * Configuration for connecting to a single remote MCP server.
 */
type MCPClientParams = {
    /** Server identifier; tool names get namespaced as `${name}__toolName`. */
    name: string;
    /** URL of the MCP server's Streamable HTTP endpoint (usually ends in `/mcp`). */
    url: string;
    /** Extra HTTP headers sent with every request, e.g. `{ Authorization: "Bearer ..." }`. */
    headers?: Record<string, string>;
};

/**
 * A tool definition shaped for OpenRouter's chat completions `tools` parameter.
 * `parameters` is the MCP tool's JSON Schema `inputSchema`, passed through as-is.
 */
export type OpenRouterTool = {
    /** Always `"function"` in the OpenRouter tool format. */
    type: "function";
    function: {
        /** Namespaced name (`serverName__toolName`) so multiple servers can't collide. */
        name: string;
        /** The MCP tool's description, or an empty string if the server gave none. */
        description: string;
        /** JSON Schema describing the arguments the model must provide. */
        parameters: Tool["inputSchema"];
    };
};

/**
 * Client for one remote MCP server over Streamable HTTP (fetch-based, Workers-compatible).
 *
 * Exposes the server's tools in OpenRouter's format for use as chat-completions `tools`,
 * and executes tool calls on the model's behalf. One instance per server; the connection
 * is lazy and deduplicated, so calling `listTools`/`callTool` without `connect` first is fine.
 */
export class MCPClient {
    /** Server identifier used for tool namespacing and error messages. */
    readonly name: string;
    private url: URL;
    private headers?: Record<string, string>;
    private client?: Client;
    /** In-flight connection attempt, so concurrent callers share a single handshake. */
    private connectPromise?: Promise<void>;

    /**
     * Creates a client for a remote MCP server. Does not connect; the first
     * `connect`/`listTools`/`callTool` performs the MCP handshake.
     */
    constructor({ name, url, headers }: MCPClientParams) {
        this.name = name;
        this.url = new URL(url);
        this.headers = headers;
    }

    /**
     * Connects to the server if not already connected. Idempotent and safe to
     * call concurrently; duplicate calls await the same in-flight handshake.
     * @throws If the MCP handshake fails (e.g. server unreachable, auth rejected).
     */
    async connect(): Promise<void> {
        if (this.client) return;
        if (!this.connectPromise) {
            this.connectPromise = this.doConnect().catch((error) => {
                this.connectPromise = undefined;
                throw error;
            });
        }
        await this.connectPromise;
    }

    /**
     * Closes the underlying session and forgets the connection. Swallows close
     * errors so a broken session never blocks a fresh `connect()`. The next
     * call to any public method reconnects lazily.
     */
    async close(): Promise<void> {
        const client = this.client;
        this.client = undefined;
        this.connectPromise = undefined;
        if (!client) return;
        await client.close().catch(() => {});
    }

    /**
     * Lists the server's tools converted to OpenRouter's `tools` format, with
     * names namespaced as `${name}__toolName` to avoid cross-server collisions.
     * Connects implicitly if needed.
     */
    async listTools(): Promise<OpenRouterTool[]> {
        await this.connect();
        const { tools } = await this.getClient().listTools();
        return tools.map((tool) => ({
            type: "function" as const,
            function: {
                name: `${this.name}__${tool.name}`,
                description: tool.description ?? "",
                parameters: tool.inputSchema,
            },
        }));
    }

    /**
     * Executes a tool on this server and returns the result as plain text for the model.
     *
     * Accepts either the namespaced name (`serverName__toolName`) or the raw
     * server-side name. If the call fails (e.g. expired session), the connection
     * is re-established and the call retried once before the error propagates.
     *
     * @param qualifiedName Tool name, optionally prefixed with `${name}__`.
     * @param args Parsed arguments matching the tool's JSON Schema (not a JSON string).
     * @returns Tool result text: joined text parts, else stringified structured content.
     * @throws If the tool call fails even after the retry.
     */
    async callTool(
        qualifiedName: string,
        args: Record<string, unknown>,
    ): Promise<string> {
        await this.connect();
        const name = this.stripPrefix(qualifiedName);
        let result: CallToolResult;
        try {
            result = (await this.getClient().callTool({
                name,
                arguments: args,
            })) as CallToolResult;
        } catch {
            await this.reconnect();
            result = (await this.getClient().callTool({
                name,
                arguments: args,
            })) as CallToolResult;
        }
        return this.extractResultText(result);
    }

    /** Performs the MCP handshake: new {@link Client} over a Streamable HTTP transport. */
    private async doConnect(): Promise<void> {
        const client = new Client({
            name: "finneas-register-bot",
            version: "1.0.0",
        });
        const transport = new StreamableHTTPClientTransport(this.url, {
            requestInit: { headers: this.headers },
        });
        await client.connect(transport);
        this.client = client;
    }

    /** Tears down and re-establishes the connection, e.g. after a session expiry. */
    private async reconnect(): Promise<void> {
        await this.close();
        await this.connect();
    }

    private getClient(): Client {
        if (!this.client) {
            throw new Error(`MCP server "${this.name}" is not connected`);
        }
        return this.client;
    }

    /** Removes this server's `${name}__` prefix if present; passes raw names through. */
    private stripPrefix(qualifiedName: string): string {
        const prefix = `${this.name}__`;
        return qualifiedName.startsWith(prefix)
            ? qualifiedName.slice(prefix.length)
            : qualifiedName;
    }

    /**
     * Flattens an MCP tool result into a single string the model can read:
     * joined text parts first, then `structuredContent`, then raw content JSON.
     * Error results (`isError`) are returned as-is so the model can react to them.
     */
    private extractResultText(result: CallToolResult): string {
        const textParts = result.content
            .filter((part): part is TextContent => part.type === "text")
            .map((part) => part.text);
        if (textParts.length > 0) {
            return textParts.join("\n");
        }
        if (result.structuredContent) {
            return JSON.stringify(result.structuredContent);
        }
        return JSON.stringify(result.content);
    }
}
