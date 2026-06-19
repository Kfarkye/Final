import { execFile } from 'child_process';
import { z } from 'zod';
import { PolicyReceipt } from '../domain/contracts';

export class PythonGovernanceBridge {
  private readonly scriptPath = '/opt/governance/bin/policy_eval.py';
  private readonly interpreter = '/usr/bin/python3';

  async evaluatePolicy(
    traceId: string, 
    payloadHash: string, 
    minifiedState: Record<string, unknown>
  ): Promise<z.infer<typeof PolicyReceipt>> {
    return new Promise((resolve, reject) => {
      const inputBuffer = Buffer.from(JSON.stringify({
        protocolVersion: '1.0.0',
        traceId,
        payloadHash,
        state: minifiedState
      }));

      // Hardened ExecFile - No shell interpolation
      const child = execFile(this.interpreter, [this.scriptPath], {
        timeout: 5000, // Strict 5s budget
        maxBuffer: 1024 * 1024, // 1MB Output Limit
        env: { 
          PYTHONUNBUFFERED: '1',
          GOVERNANCE_STRICT_MODE: 'true'
        }
      }, (error, stdout, stderr) => {
        if (error) {
          if (error.killed) return reject(new Error('TIMEOUT'));
          return reject(new Error(`BRIDGE_FAILED: ${error.code}`));
        }

        try {
          const rawOutput = JSON.parse(stdout);
          // Strict Output Schema Validation
          const receipt = PolicyReceipt.parse(rawOutput);
          resolve(receipt);
        } catch (parseError) {
          // Fail-closed on parsing errors
          reject(new Error('MALFORMED_POLICY_RESPONSE'));
        }
      });

      if (child.stdin) {
        child.stdin.write(inputBuffer);
        child.stdin.end();
      }
    });
  }
}
