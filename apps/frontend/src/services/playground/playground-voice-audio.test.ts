import { describe, expect, it } from "vitest";
import { PlaygroundVoiceActivity } from "./playground-voice-audio";

describe("Groq microphone turns", () => {
  it("does not send silence or isolated noise, retains speech onset and waits for a pause", () => {
    const activity = new PlaygroundVoiceActivity();
    const quiet = new Float32Array(1600);
    const speech = new Float32Array(1600).fill(0.1);
    for (let i = 0; i < 30; i++) expect(activity.push(quiet)).toBeNull();
    expect(activity.push(speech)).toBeNull();
    for (let i = 0; i < 20; i++) expect(activity.push(quiet)).toBeNull();
    for (let i = 0; i < 3; i++) activity.push(quiet);
    activity.push(speech);
    activity.push(speech);
    for (let i = 0; i < 19; i++) expect(activity.push(quiet)).toBeNull();
    const turn = activity.push(quiet)!;
    expect(turn.length).toBe(25 * 1600);
    expect(turn[3 * 1600]).toBeCloseTo(0.1);
  });

  it("restarts the two-second pause when speech resumes", () => {
    const activity = new PlaygroundVoiceActivity();
    const quiet = new Float32Array(1600);
    const speech = new Float32Array(1600).fill(0.1);
    activity.push(speech);
    activity.push(speech);
    for (let i = 0; i < 15; i++) expect(activity.push(quiet)).toBeNull();
    expect(activity.push(speech)).toBeNull();
    for (let i = 0; i < 19; i++) expect(activity.push(quiet)).toBeNull();
    expect(activity.push(quiet)).not.toBeNull();
  });

  it("bounds continuous speech to 20 seconds and discards a muted partial turn", () => {
    const activity = new PlaygroundVoiceActivity();
    const speech = new Float32Array(1600).fill(0.1);
    for (let i = 0; i < 199; i++) expect(activity.push(speech)).toBeNull();
    expect(activity.push(speech)?.length).toBe(320000);
    activity.push(speech);
    activity.reset();
    for (let i = 0; i < 10; i++)
      expect(activity.push(new Float32Array(1600))).toBeNull();
  });
});
