import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SingleFlightGate } from '../src/hooks/singleFlight.ts';

test('the guard covers one attempt and queues a single follow-up while recording', () => {
  const gate = new SingleFlightGate();
  gate.beginRecording();

  const first = gate.requestRun();
  assert.equal(typeof first, 'number');
  assert.equal(gate.requestRun(), null);
  assert.equal(gate.finishRun(first as number), true);

  const second = gate.requestRun();
  assert.equal(typeof second, 'number');
  assert.notEqual(second, first);
  assert.equal(gate.finishRun(second as number), false);
});

test('stopping invalidates the in-flight attempt so it cannot start another upload', () => {
  const gate = new SingleFlightGate();
  gate.beginRecording();
  const inflight = gate.requestRun() as number;
  assert.equal(gate.requestRun(), null);

  gate.cancelRecording();
  assert.equal(gate.isActive, false);
  assert.equal(gate.finishRun(inflight), false);

  const finalRun = gate.requestRun();
  assert.equal(typeof finalRun, 'number');
  assert.notEqual(finalRun, inflight);
  assert.equal(gate.finishRun(finalRun as number), false);
});
