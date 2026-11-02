/**
 * Platform differences between POSIX and Windows, in one place.
 * Windows cannot exec `.cmd`/`.bat` files directly, resolves command names through `PATHEXT`, and git helpers run through
 * Git for Windows' `sh`, which needs forward slashes.
 */
import { readFileSync } from 'node:fs'

export const isWindows = process.platform === 'win32'
/** Extensions Windows appends when resolving a bare command name, longest-match order as `PATHEXT` lists them. */
const WINDOWS_EXTENSIONS = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.trim()).filter(Boolean)
/** Lines a generated wrapper uses for its own bookkeeping, not for the command it forwards to. */
const WRAPPER_NOISE = /^(?:@?echo|@?rem|@?set|@?setlocal|@?exit|@?goto|@?call|@?if|@?for|:)/i
const TOKEN = /"([^"]*)"|(\S+)/g

/** True for a path Windows must launch through a shell because CreateProcess cannot start batch files. */
export const isBatch = (program: string): boolean => isWindows && /\.(cmd|bat)$/i.test(program)
const powerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`
/**
 * PowerShell arguments that run `command` verbatim.
 * `-EncodedCommand` carries the command as base64 of UTF-16LE, so no layer — Node's argv escaping, `cmd.exe`, or
 * PowerShell's own parser — ever sees its quotes.
 */
const powerShellArgs = (command: string): string[] =>
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]
/**
 * Reads the command a wrapper `.cmd` forwards to, so host calls reach the real program instead of going through
 * `cmd.exe`. That detour is lossy: `cmd` re-parses the command line and drops the double quotes of a JSON argument.
 * The wrapper's literal `set` lines come along as environment overrides, because skipping `cmd.exe` would otherwise
 * skip them too — that is how the bot CLI gets its own configuration directory.
 * Returns undefined when no single forwarding line is recognisable, and the caller falls back to the shell.
 */
function batchForward(program: string): { program: string; args: string[]; env: Record<string, string> } | undefined {
  let text: string
  try { text = readFileSync(program, 'utf8') } catch { return undefined }
  const env: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    // A `set` with a literal value is part of what the wrapper does for its target; one with `%` or `!` computes a value
    // this parser cannot evaluate, so the whole wrapper is left to the shell.
    const assignment = /^@?set\s+"([A-Za-z_][A-Za-z0-9_]*)=(.*)"$/i.exec(line)
    if (assignment) {
      const [, name, value] = assignment
      if (/[%!^]/.test(value!)) return undefined
      env[name!] = value!
      continue
    }
    if (WRAPPER_NOISE.test(line) && !assignment) continue
    const tokens = [...line.matchAll(TOKEN)].map(match => match[1] ?? match[2]!)
    const [target, ...rest] = tokens
    // Only a line that ends in `%*` forwards its own arguments; anything else is setup this parser must not skip.
    if (!target || !/\.[A-Za-z0-9]+$/.test(target) || !rest.includes('%*')) continue
    const prefix = rest.filter(token => token !== '%*')
    if ([target, ...prefix].some(token => token.includes('%'))) return undefined
    return { program: target, args: prefix, env }
  }
  return undefined
}
/**
 * Rewrites a program and its arguments into something the OS can launch. A wrapper `.cmd` is followed to the program it
 * forwards to, along with the environment it sets; if that is not recognisable, it runs through PowerShell's call
 * operator over single-quoted literals. `cmd.exe /c` is never used because Node quotes each argument and `cmd` then
 * strips the wrong quotes.
 */
export function launchable(program: string, args: readonly string[]): { program: string; args: string[]; env?: Record<string, string> } {
  if (!isBatch(program)) return { program, args: [...args] }
  const forward = batchForward(program)
  if (forward) return { program: forward.program, args: [...forward.args, ...args], env: forward.env }
  const line = [program, ...args].map(powerShellLiteral).join(' ')
  return { program: 'powershell', args: powerShellArgs(`& ${line}`) }
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
  ? ['powershell', ...powerShellArgs(command)]
  : ['sh', '-c', command]
