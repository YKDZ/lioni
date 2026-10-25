const controller = new AbortController();
const interrupt = (): void => controller.abort();

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, interrupt);

export const externalInterruptSignal = controller.signal;
