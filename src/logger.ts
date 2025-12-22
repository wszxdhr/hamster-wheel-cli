import chalk from 'chalk';

export interface LoggerOptions {
  readonly verbose?: boolean;
}

export class Logger {
  private readonly verbose: boolean;

  constructor(options: LoggerOptions = {}) {
    this.verbose = options.verbose ?? false;
  }

  info(message: string): void {
    console.log(this.formatLine(chalk.blue('info'), '  ', message));
  }

  success(message: string): void {
    console.log(this.formatLine(chalk.green('ok'), '    ', message));
  }

  warn(message: string): void {
    console.warn(this.formatLine(chalk.yellow('warn'), '  ', message));
  }

  error(message: string): void {
    console.error(this.formatLine(chalk.red('err'), '   ', message));
  }

  debug(message: string): void {
    if (!this.verbose) return;
    console.log(this.formatLine(chalk.magenta('dbg'), '   ', message));
  }

  private formatLine(label: string, padding: string, message: string): string {
    const timestamp = this.formatTimestamp(new Date());
    return `${chalk.gray(timestamp)} ${label}${padding}${message}`;
  }

  private formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = this.pad2(date.getMonth() + 1);
    const day = this.pad2(date.getDate());
    const hours = this.pad2(date.getHours());
    const minutes = this.pad2(date.getMinutes());
    const seconds = this.pad2(date.getSeconds());
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  private pad2(value: number): string {
    return String(value).padStart(2, '0');
  }
}

export const defaultLogger = new Logger();
