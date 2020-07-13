/* eslint-disable */
// Provides dev-time type structures for  `danger` - doesn't affect runtime.
import { DangerDSLType } from "../node_modules/danger/distribution/dsl/DangerDSL";
declare let danger: DangerDSLType;
export declare function message(message: string, file?: string, line?: number): void;
export declare function warn(message: string, file?: string, line?: number): void;
export declare function fail(message: string, file?: string, line?: number): void;
export declare function markdown(message: string, file?: string, line?: number): void;
function ignore(message: string, file?: string, line?: number): void {
  return;
}
/* eslint-enable */

import { CLIEngine, Linter } from "eslint";

export interface OutputMessage {
  /** Which danger-reporter would originally have been used for a message of this severity */
  suggestedReporter: typeof message | typeof warn | typeof fail | typeof markdown | typeof ignore;

  /** A preformatted string */
  formattedMessage: string;
  /** The file-path in which the error occurred */
  filePath: string;
  /** The line number on which the error started */
  line: number;
  /** eslint might have an auto-fix, or one or more Suggestions */
  hasFixesOrSuggestions: boolean;

  /** The raw message out of eslint */
  linterMessage: Linter.LintMessage;
}

export type OnLintMessage = (msg: OutputMessage) => Promise<void>;

export type EslintOptions = string | CLIEngine.Options["baseConfig"];

export interface PluginOptions {
  /** Override the base extensions from the Eslint Config */
  extensions?: string[];

  /**
   * If you want to choose which messages to output and which to suppress
   * (depending on Pull Request Labels for example), you can hook in to this function
   */
  onLintMessage?: OnLintMessage;
}

const DefaultExtensions = [".js"];

/**
 * Eslint your code with Danger
 */
export default async function eslint(
  config: EslintOptions,
  extensionsOrOptions: string[] | PluginOptions = DefaultExtensions
): Promise<void[]> {
  const allFiles = danger.git.created_files.concat(danger.git.modified_files);

  let parsedConfig: CLIEngine.Options["baseConfig"];
  if (typeof config === "string") {
    parsedConfig = JSON.parse(config);
  } else {
    parsedConfig = config;
  }
  const eslintOptions: CLIEngine.Options = { baseConfig: parsedConfig };

  let pluginOptions: PluginOptions = {};
  if (extensionsOrOptions != null) {
    if (Array.isArray(extensionsOrOptions)) {
      eslintOptions.extensions = extensionsOrOptions ?? DefaultExtensions;
    } else {
      pluginOptions = extensionsOrOptions;
      eslintOptions.extensions = extensionsOrOptions.extensions ?? DefaultExtensions;
    }
    if (eslintOptions.baseConfig) {
      // We want to ignore eslintrc files on disk if a config was passed in!
      // this is particularly important for our own unit tests
      eslintOptions.useEslintrc = false;
    }
  }
  const cli = new CLIEngine(eslintOptions);
  // let eslint filter down to non-ignored, matching the extensions expected
  const filesToLint = allFiles.filter((f) => {
    return !cli.isPathIgnored(f) && eslintOptions.extensions.some((ext) => f.endsWith(ext));
  });
  return Promise.all(filesToLint.map((f) => lintFile(cli, eslintOptions, pluginOptions, f)));
}

function lookupSuggestedReporter(severity: Linter.LintMessage["severity"]): OutputMessage["suggestedReporter"] {
  return ({ 1: warn, 2: fail }[severity] || ignore) as OutputMessage["suggestedReporter"];
}

async function defaultOnLintMessage({
  formattedMessage,
  suggestedReporter,
  filePath,
  linterMessage: { line },
}: OutputMessage): Promise<void> {
  return Promise.resolve(suggestedReporter(formattedMessage, filePath, line));
}

async function lintFile(
  linter: CLIEngine,
  engineOptions: CLIEngine.Options,
  pluginOptions: PluginOptions,
  filePath: string
) {
  const contents = await danger.github.utils.fileContents(filePath);
  const report = linter.executeOnText(contents, filePath);

  if (report && report.results && report.results.length !== 0) {
    await Promise.all(
      report.results[0].messages.map(async (msg) => {
        if (msg.fatal) {
          const fatalMessage = `Fatal error linting ${filePath} with eslint. ${JSON.stringify(msg)}`;
          fail(fatalMessage);
          return Promise.reject(fatalMessage);
        }

        const hasFixesOrSuggestions = !!msg.fix || (Array.isArray(msg.suggestions) && msg.suggestions.length > 0);

        return await (pluginOptions.onLintMessage || defaultOnLintMessage)({
          formattedMessage: `${filePath} line ${msg.line} – ${msg.message} (${msg.ruleId})`,
          filePath,
          line: msg.line,
          hasFixesOrSuggestions,
          linterMessage: msg,
          suggestedReporter: lookupSuggestedReporter(msg.severity),
        });
      })
    );
  }
}
