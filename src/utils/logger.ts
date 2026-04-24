/**
 * Centralized Logger for Financial Agent Harness
 */

const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    darkGray: '\x1b[100m', // Background for privacy logs
};

import fs from 'fs';
import { EventEmitter } from 'events';

const emitter = new EventEmitter();

export class Logger {
    private static logFilePath: string | null = null;

    static on(event: string, listener: (...args: any[]) => void) {
        emitter.on(event, listener);
    }

    private static emit(event: string, ...args: any[]) {
        emitter.emit(event, ...args);
    }

    static setLogFile(path: string) {
        this.logFilePath = path;
        // Clear file if it exists
        fs.writeFileSync(path, '');
    }

    private static formatTimestamp(includeColors = true): string {
        const now = new Date();
        const date = now.toISOString().split('T')[0];
        const time = now.toTimeString().split(' ')[0];
        const ms = now.getMilliseconds().toString().padStart(3, '0');
        const ts = `[${date} ${time}.${ms}]`;
        if (!includeColors) return ts;
        return `${COLORS.gray}${ts}${COLORS.reset}`;
    }

    private static stripColors(text: string): string {
        return text.replace(/\x1b\[[0-9;]*m/g, '');
    }

    private static log(level: string, color: string, ...args: any[]) {
        const timestamp = this.formatTimestamp();
        const prefix = `${color}${level.padEnd(8)}${COLORS.reset}`;
        console.log(`${timestamp} ${prefix}`, ...args);

        // Emit log event for UI/External listeners
        const content = args.map(arg => 
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
        ).join(' ');
        this.emit('log', level, this.stripColors(content));

        if (this.logFilePath) {
            const fileTimestamp = this.formatTimestamp(false);
            const content = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            const logLine = `${fileTimestamp} ${level.padEnd(8)} ${this.stripColors(content)}\n`;
            fs.appendFileSync(this.logFilePath, logLine);
        }
    }

    static info(...args: any[]) {
        this.log('INFO', COLORS.cyan, ...args);
    }

    static success(...args: any[]) {
        this.log('SUCCESS', COLORS.green, ...args);
    }

    static warn(...args: any[]) {
        this.log('WARN', COLORS.yellow, ...args);
    }

    static error(...args: any[]) {
        const timestamp = this.formatTimestamp();
        const prefix = `${COLORS.red}${'ERROR/FATAL'.padEnd(8)}${COLORS.reset}`;
        console.error(`${timestamp} ${prefix}`, ...args);

        if (this.logFilePath) {
            const fileTimestamp = this.formatTimestamp(false);
            const content = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            const logLine = `${fileTimestamp} ERROR    ${this.stripColors(content)}\n`;
            fs.appendFileSync(this.logFilePath, logLine);
        }
    }

    static agent(...args: any[]) {
        this.log('AGENT', COLORS.magenta, ...args);
    }

    static tool(...args: any[]) {
        this.log('TOOL', COLORS.blue, ...args);
    }

    static debug(...args: any[]) {
        if (process.env.DEBUG) {
            this.log('DEBUG', COLORS.gray, ...args);
        }
    }

    static privacy(...args: any[]) {
        this.log('PRIVACY', COLORS.magenta, ...args);
    }

    /** Write raw text to both console and log file without newlines/prefixes (for streaming) */
    static stream(text: string) {
        process.stdout.write(text);
        if (this.logFilePath) {
            fs.appendFileSync(this.logFilePath, text);
        }
    }

    /** Special divider for visual clarity in logs */
    static divider(char = '═', length = 60) {
        const line = char.repeat(length);
        console.log(`${COLORS.gray}${line}${COLORS.reset}`);
        
        if (this.logFilePath) {
            fs.appendFileSync(this.logFilePath, `${line}\n`);
        }
    }
}
