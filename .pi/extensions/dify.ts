/**
 * Loads the Dify integration for anyone running pi in this repo.
 *
 * Implementation lives in integrations/dify/ so the same modules back the pi
 * extension, the MCP server on the Hermes VM, and the doctor CLI.
 */

export { default } from "../../integrations/dify/src/extension.ts";
