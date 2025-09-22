import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import type { ChildProcess } from 'child_process';

export class TestServer {
  private process: ChildProcess | null = null;
  private port: number = 0;

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const serverPath = join(import.meta.dir, '..', '..', 'src', 'server.ts');
      // Start server on port 0 (random available port)
      const defaultDbPath = join(process.cwd(), 'server', 'db', 'terminology.sqlite');
      const terminologyDbPath = process.env.TERMINOLOGY_DB_PATH || defaultDbPath;
      if (!existsSync(terminologyDbPath)) {
        reject(new Error(`Terminology database not found at ${terminologyDbPath}`));
        return;
      }

      const defaultValidatorJar = join(process.cwd(), 'server', 'validator.jar');
      const validatorJar = process.env.VALIDATOR_JAR || defaultValidatorJar;

      this.process = spawn('bun', ['run', serverPath], {
        env: {
          ...process.env,
          PORT: '0', // Let OS assign a random available port
          TERMINOLOGY_DB_PATH: terminologyDbPath,
          VALIDATOR_JAR: validatorJar,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      const timeout = setTimeout(() => {
        reject(new Error('Server failed to start within 10 seconds'));
      }, 10000);

      this.process.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        // Look for the port in the output
        const match = output.match(/running at http:\/\/localhost:(\d+)/);
        if (match) {
          this.port = parseInt(match[1]);
          clearTimeout(timeout);
          resolve(this.port);
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        console.error('[Test Server Error]', data.toString());
      });

      this.process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });
  }

  async stop() {
    if (this.process) {
      this.process.kill('SIGTERM');
      // Give it time to gracefully shutdown
      await new Promise((r) => setTimeout(r, 500));
      if (this.process.exitCode === null) {
        this.process.kill('SIGKILL');
      }
      this.process = null;
    }
  }

  getPort(): number {
    return this.port;
  }

  getBaseUrl(): string {
    return `http://localhost:${this.port}`;
  }
}
