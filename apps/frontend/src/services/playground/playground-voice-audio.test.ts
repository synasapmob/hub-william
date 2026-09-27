import { describe, expect, it } from "vitest";
import { PlaygroundVoiceActivity } from "./playground-voice-audio";

describe("Groq microphone turns", () => {
  it("does not send silence or isolated noise, retains speech onset and waits for a pause", () => {
    const activity = new PlaygroundVoiceActivity();
    const quiet = new Float32Array(1600);
    const speech = new Float32Array(1600).fill(0.1);
    for (let i = 0; i < 30; i++) expect(activity.push(quiet, 0.01)).toBeNull();
    expect(activity.push(speech, 0.95)).toBeNull();
    for (let i = 0; i < 20; i++) expect(activity.push(quiet, 0.01)).toBeNull();
    for (let i = 0; i < 3; i++) activity.push(quiet, 0.01);
    activity.push(speech, 0.95);
    activity.push(speech, 0.95);
    for (let i = 0; i < 19; i++) expect(activity.push(quiet, 0.01)).toBeNull();
    const turn = activity.push(quiet, 0.01)!;
    expect(turn.length).toBe(25 * 1600);
    expect(turn[3 * 1600]).toBeCloseTo(0.1);
  });

  it("restarts the two-second pause when speech resumes", () => {
    const activity = new PlaygroundVoiceActivity();
    const quiet = new Float32Array(1600);
    const speech = new Float32Array(1600).fill(0.1);
    activity.push(speech, 0.95);
    activity.push(speech, 0.95);
    for (let i = 0; i < 15; i++) expect(activity.push(quiet, 0.01)).toBeNull();
    expect(activity.push(speech, 0.95)).toBeNull();
    for (let i = 0; i < 19; i++) expect(activity.push(quiet, 0.01)).toBeNull();
    expect(activity.push(quiet, 0.01)).not.toBeNull();
  });

  it("bounds continuous speech to 20 seconds and discards a muted partial turn", () => {
    const activity = new PlaygroundVoiceActivity();
    const speech = new Float32Array(1600).fill(0.1);
    for (let i = 0; i < 199; i++)
      expect(activity.push(speech, 0.95)).toBeNull();
    expect(activity.push(speech, 0.95)?.length).toBe(320000);
    activity.push(speech, 0.95);
    activity.reset();
    for (let i = 0; i < 10; i++)
      expect(activity.push(new Float32Array(1600), 0.01)).toBeNull();
  });
});
