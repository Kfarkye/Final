import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { CodexClient } from '../CodexClient';
import { CodexSupervisor } from '../CodexSupervisor';
import { Telemetry, ApprovalPolicy, TenantContext, ApprovalDecision } from '../types';
import { spawn } from 'node:child_process';

vi.mock('node:child_process', () => {
  const sm = vi.fn();
  return {
    default: { spawn: sm },
    spawn: sm,
  };
});

class MockTelemetry implements Telemetry {
  log() {}
  counterAdd() {}
  gaugeSet() {}
  startSpan() {
    return {
      setAttribute: () => {},
      recordException: () => {},
      setStatusError: () => {},
      end: () => {}
    } as any;
  }
}

class MockApprovalPolicy implements ApprovalPolicy {
  async evaluate(): Promise<ApprovalDecision> {
    return { allow: true };
  }
}

describe('Codex System Suite', () => {
  let mockProc: any;
  let mockStdin: any;
  let mockStdout: any;
  let mockStderr: any;

  beforeEach(() => {
    vi.useFakeTimers();

    mockStdin = new EventEmitter();
    mockStdin.write = vi.fn().mockReturnValue(true);
    mockStdin.end = vi.fn();
    mockStdin.writable = true;

    mockStdout = new EventEmitter();
    mockStdout.setEncoding = vi.fn();
    mockStdout.resume = vi.fn();
    mockStdout.pause = vi.fn();

    mockStderr = new EventEmitter();
    mockStderr.setEncoding = vi.fn();

    mockProc = new EventEmitter();
    mockProc.stdin = mockStdin;
    mockProc.stdout = mockStdout;
    mockProc.stderr = mockStderr;
    mockProc.kill = vi.fn();

    vi.mocked(spawn).mockReturnValue(mockProc as any);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('connects and handshakes successfully', async () => {
    const client = new CodexClient({
      command: 'dummy',
      telemetry: new MockTelemetry(),
      approvalPolicy: new MockApprovalPolicy(),
      handshakeTimeoutMs: 1000,
    });

    const connectPromise = client.connect({ name: 'test', version: '1', title: 'test' });
    
    // Simulate process stdout emitting initialized response
    setTimeout(() => {
      mockStdout.emit('data', JSON.stringify({
        id: 0,
        result: { userAgent: 'test', platformOs: 'test' }
      }) + '\n');
    }, 10);

    vi.advanceTimersByTime(20);
    
    const res = await connectPromise;
    expect(res).toBeDefined();
    expect(client.isReady).toBe(true);
  });

  it('circuit breaker trips on continuous crashes', async () => {
    const supervisor = new CodexSupervisor(1, {
      clientConfig: { 
        command: 'dummy', 
        telemetry: new MockTelemetry(), 
        approvalPolicy: new MockApprovalPolicy(),
        handshakeTimeoutMs: 1000 
      },
      clientInfo: { name: 'test', version: '1', title: 'test' },
      circuitFailureThreshold: 2,
      circuitWindowMs: 1000,
      circuitOpenMs: 10000,
      restartBackoffBaseMs: 100,
      restartBackoffMaxMs: 1000,
    });

    // Start it, but we'll immediately crash it
    const startPromise = supervisor.start();
    
    // Crash 1 during handshake
    mockProc.emit('exit', 1, null, false);
    
    // Catch the handshake failure
    await startPromise.catch(() => {});
    
    // Advance time to trigger the restart
    vi.advanceTimersByTime(200);

    // supervisor should have tried to restart (spawnMock called again)
    // Crash 2
    mockProc.emit('exit', 1, null, false);

    // Should trip the breaker
    vi.advanceTimersByTime(200);

    // Should throw CodexUnavailableError (circuit is open)
    await expect(supervisor.run({ tenantId: 'test', requestId: 'req' }, async () => {}))
      .rejects.toThrow(/circuit is open/);
  });

  it('handles backpressure correctly', async () => {
    const client = new CodexClient({
      command: 'dummy',
      telemetry: new MockTelemetry(),
      approvalPolicy: new MockApprovalPolicy(),
      handshakeTimeoutMs: 1000,
    });

    const connectPromise = client.connect({ name: 'test', version: '1', title: 'test' });
    
    setTimeout(() => {
      mockStdout.emit('data', JSON.stringify({
        id: 0,
        result: { userAgent: 'test', platformOs: 'test' }
      }) + '\n');
    }, 10);

    vi.advanceTimersByTime(20);
    await connectPromise;

    // Simulate backpressure
    mockStdin.write.mockReturnValue(false);

    // Fire off a request
    const reqPromise = client.startThread('model', { tenantId: 'test', requestId: 'req' });

    // Ensure it hasn't resolved and write queue has been processed but blocked
    expect(mockStdin.write).toHaveBeenCalled();
    
    // Release backpressure
    mockStdin.write.mockReturnValue(true);
    setTimeout(() => {
      mockStdin.emit('drain');
      // Send response
      mockStdout.emit('data', JSON.stringify({
        id: 1,
        result: { thread: { id: 'thread-1' } }
      }) + '\n');
    }, 10);

    vi.advanceTimersByTime(20);

    const result = await reqPromise;
    expect((result as any).thread.id).toBe('thread-1');
  });
});
