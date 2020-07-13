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
  /** The relative-file-path in which the error occurred -- relative to PluginOptions.relativeBasePath */
  relativeFilePath: string;

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

  /**
   * If you're executing eslint outside the root of your repo, you may need this.
   *  (Monorepos may want to configure this)
   * Any files that that do not start with this path prefix will be skipped!
   */
  relativeBasePath?: string;
}

type InternalPluginOptions = Required<PluginOptions>;

const DefaultExtensions = [".js"];

/**
 * Eslint your code with Danger
 */
export default async function eslint(
  config: EslintOptions,
  extensionsOrOptions: string[] | PluginOptions = DefaultExtensions
): Promise<void[]> {
  let parsedConfig: CLIEngine.Options["baseConfig"];
  if (typeof config === "string") {
    parsedConfig = JSON.parse(config);
  } else {
    parsedConfig = config;
  }
  const eslintOptions: CLIEngine.Options = { baseConfig: parsedConfig };

  let pluginOptions: InternalPluginOptions = {
    extensions: DefaultExtensions,
    relativeBasePath: "",
    onLintMessage: defaultOnLintMessage,
  };

  if (extensionsOrOptions != null) {
    if (Array.isArray(extensionsOrOptions)) {
      eslintOptions.extensions = pluginOptions.extensions = extensionsOrOptions ?? DefaultExtensions;
    } else {
      pluginOptions = {
        ...pluginOptions,
        ...extensionsOrOptions,
        extensions: extensionsOrOptions.extensions ?? DefaultExtensions,
      };
      eslintOptions.extensions = pluginOptions.extensions;
    }
    if (eslintOptions.baseConfig) {
      // We want to ignore eslintrc files on disk if a config was passed in!
      // this is particularly important for our own unit tests
      eslintOptions.useEslintrc = false;
    }
  }
  const cli = new CLIEngine(eslintOptions);

  const allFiles = danger.git.created_files.concat(danger.git.modified_files).map((filePath) => ({
    filePath,
    relativeFilePath: makeRelativePathOrNull(pluginOptions.relativeBasePath, filePath),
  }));

  // let eslint filter down to non-ignored, matching the extensions expected
  const filesToLint = allFiles.filter(({ relativeFilePath }) => {
    return (
      !!relativeFilePath && // File is under control of the pluginOptions.relativeBasePath
      !cli.isPathIgnored(relativeFilePath) &&
      eslintOptions.extensions.some((ext) => relativeFilePath.endsWith(ext))
    );
  });
  return Promise.all(filesToLint.map((f) => lintFile(cli, eslintOptions, pluginOptions, f)));
}

function makeRelativePathOrNull(basePath: string, filePath: string) {
  if (basePath === "") {
    // User wants traditional behavior
    return filePath;
  }
  const chunks = filePath.split(basePath);
  if (chunks.length < 2) {
    // basePath is not in the filePath -- so this file is outside our directory!
    return null;
  }

  // Drop the first basePath
  chunks.shift();

  // Rejoin the remaining chunks (in case basePath is in there multiple times)
  const candidate = chunks.join(basePath);
  if (candidate.startsWith("/")) {
    // Make sure the path doesn't start with a trailing slash
    return candidate.slice(1);
  }
  return candidate;
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
  pluginOptions: InternalPluginOptions,
  { filePath, relativeFilePath }: { filePath: string; relativeFilePath: string }
) {
  const contents = await danger.github.utils.fileContents(filePath);
  const report = linter.executeOnText(contents, relativeFilePath);

  if (report && report.results && report.results.length !== 0) {
    await Promise.all(
      report.results[0].messages.map(async (msg) => {
        if (msg.fatal) {
          const fatalMessage = `Fatal error linting ${filePath} with eslint. ${JSON.stringify(msg)}`;
          fail(fatalMessage);
          return Promise.reject(fatalMessage);
        }

        const hasFixesOrSuggestions = !!msg.fix || (Array.isArray(msg.suggestions) && msg.suggestions.length > 0);

        return await pluginOptions.onLintMessage({
          formattedMessage: `${relativeFilePath} line ${msg.line} – ${msg.message} (${msg.ruleId})`,
          filePath,
          relativeFilePath,
          line: msg.line,
          hasFixesOrSuggestions,
          linterMessage: msg,
          suggestedReporter: lookupSuggestedReporter(msg.severity),
        });
      })
    );
  }
}
