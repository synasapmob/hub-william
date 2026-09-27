declare module "@diffusionstudio/piper-wasm/build/piper_phonemize.js" {
  interface PlaygroundPiperModule {
    callMain: (args: string[]) => void;
  }
  interface PlaygroundPiperModuleOptions {
    wasmBinary: ArrayBuffer;
    getPreloadedPackage: () => ArrayBuffer;
    locateFile: (path: string) => string;
    print: (text: string) => void;
    printErr: (text: string) => void;
    onAbort: (error: unknown) => void;
  }
  export default function createPiperPhonemize(
    options: PlaygroundPiperModuleOptions,
  ): Promise<PlaygroundPiperModule>;
}
