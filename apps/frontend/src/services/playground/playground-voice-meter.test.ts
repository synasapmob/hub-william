import { afterEach, expect, it, vi } from "vitest";
import PlaygroundVoiceMeter from "./playground-voice-meter";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("measures real stream samples without playing the mic and stops sampling before async cleanup", async () => {
  vi.useFakeTimers();
  let amplitude = 0;
  let closed!: () => void;
  const disconnect = vi.fn();
  const connect = vi.fn();
  const analyser = {
    fftSize: 0,
    getFloatTimeDomainData: (samples: Float32Array) => samples.fill(amplitude),
    disconnect,
  };
  const close = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        closed = resolve;
      }),
  );
  vi.stubGlobal(
    "AudioContext",
    class {
      resume = vi.fn().mockResolvedValue(undefined);
      close = close;
      createAnalyser = () => analyser;
      createMediaStreamSource = () => ({ connect, disconnect });
    },
  );
  const onLevel = vi.fn();
  const meter = new PlaygroundVoiceMeter();
  await meter.resume();
  meter.observe({} as MediaStream, onLevel);
  vi.advanceTimersByTime(100);
  expect(onLevel).toHaveBeenLastCalledWith(0);
  amplitude = 0.08;
  vi.advanceTimersByTime(100);
  expect(onLevel.mock.lastCall?.[0]).toBeCloseTo(0.08);
  expect(connect).toHaveBeenCalledExactlyOnceWith(analyser);
  const ending = meter.end();
  expect(meter.end()).toBe(ending);
  expect(disconnect).toHaveBeenCalledTimes(2);
  expect(onLevel).toHaveBeenLastCalledWith(0);
  const count = onLevel.mock.calls.length;
  vi.advanceTimersByTime(1000);
  expect(onLevel).toHaveBeenCalledTimes(count);
  expect(close).toHaveBeenCalledOnce();
  closed();
  await ending;
});
