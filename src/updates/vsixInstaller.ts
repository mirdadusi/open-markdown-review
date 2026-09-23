export const VSIX_INSTALL_COMMANDS = [
  "workbench.extensions.installExtension",
  "workbench.extensions.command.installFromVSIX",
] as const;

export async function installVsixThroughWorkbench(
  uri: unknown,
  execute: (command: string, ...args: unknown[]) => PromiseLike<unknown>,
): Promise<(typeof VSIX_INSTALL_COMMANDS)[number]> {
  const errors: unknown[] = [];
  for (const command of VSIX_INSTALL_COMMANDS) {
    try {
      await execute(command, uri);
      return command;
    } catch (error) {
      errors.push(error);
    }
  }
  throw new AggregateError(errors, "VS Code could not install the verified VSIX.");
}
