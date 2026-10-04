// Tests describe Roughdraft outside Orca unless they say otherwise. Without
// this, running the suite from an Orca terminal would make `open` tests drive
// real Orca tabs, because many tests build their env from `process.env`.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("ORCA_")) delete process.env[name];
}
delete process.env.ROUGHDRAFT_ORCA;
if (process.env.TERM_PROGRAM === "Orca") delete process.env.TERM_PROGRAM;
