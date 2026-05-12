import { describe, it, expect } from 'vitest';
import { JobController } from '../../../src/queue/JobController.js';

describe('JobController', () => {
  it('starts with no reason and non-aborted signal', () => {
    const ctrl = new JobController();
    expect(ctrl.reason).toBeNull();
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('cancel() sets reason and aborts signal', () => {
    const ctrl = new JobController();
    ctrl.cancel();
    expect(ctrl.reason).toBe('cancel');
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('interrupt() sets reason and aborts signal', () => {
    const ctrl = new JobController();
    ctrl.interrupt();
    expect(ctrl.reason).toBe('interrupt');
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('abort() sets reason and aborts signal', () => {
    const ctrl = new JobController();
    ctrl.abort();
    expect(ctrl.reason).toBe('abort');
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('first caller wins — subsequent calls are ignored', () => {
    const ctrl = new JobController();
    ctrl.cancel();
    ctrl.abort();
    ctrl.interrupt();
    expect(ctrl.reason).toBe('cancel');
  });

  it('signal fires abort event', () => {
    const ctrl = new JobController();
    let fired = false;
    ctrl.signal.addEventListener('abort', () => { fired = true; });
    ctrl.interrupt();
    expect(fired).toBe(true);
  });
});
