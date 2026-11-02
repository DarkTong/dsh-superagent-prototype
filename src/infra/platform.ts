/**
 * Platform differences between POSIX and Windows, in one place.
 * Windows cannot exec `.cmd`/`.bat` files directly, resolves command names through `PATHEXT`, and git helpers run through
 * Git for Windows' `sh`, which needs forward slashes.
 */
export const isWindows = process.platform === 'win32'
/** Extensions Windows appends when resolving a bare command name, longest-match order as `PATHEXT` lists them. */
const WINDOWS_EXTENSIONS = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.trim()).filter(Boolean)

/** True for a path Windows must launch through a shell because CreateProcess cannot start batch files. */
export const isBatch = (program: string): boolean => isWindows && /\.(cmd|bat)$/i.test(program)
const powerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`
/**
 * Rewrites a program and its arguments into something the OS can launch: batch files run through PowerShell's call
 * operator, whose argument list is a single command string of quoted literals. `cmd.exe /c` cannot be used here because
 * Node quotes each argument and `cmd` then strips the wrong quotes; a command string without double quotes survives that
 * escaping intact.
 */
export function launchable(program: string, args: readonly string[]): { program: string; args: string[] } {
  if (!isBatch(program)) return { program, args: [...args] }
  const line = [program, ...args].map(powerShellLiteral).join(' ')
  return { program: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', `& ${line}`] }
}
/** Forward slashes for values read by Git for Windows' `sh` (a credential helper) and by `git config`, which treats `\` as an escape. */
export const posixPath = (path: string): string => isWindows ? path.replaceAll('\\', '/') : path
/** Candidate file names for an executable lookup: the name itself, then each `PATHEXT` suffix on Windows. */
export function executableNames(name: string): string[] {
  if (!isWindows) return [name]
  return [name, ...WINDOWS_EXTENSIONS.map(ext => name + ext.toLowerCase())]
}
/** argv that runs a shell command line in the platform's shell; Windows has no `/bin/sh`, so a prepare command runs in PowerShell. */
export const shellArgv = (command: string): string[] => isWindows
  ? ['pwsh', '-NoProfile', '-NonInteractive', '-Command', command]
  : ['sh', '-c', command]
