globalThis.fetch = async () => { throw new Error("Real network disabled for mock-only validation"); };
for (const name of ["node:http", "node:https"]) {
  const m = require(name);
  m.request = m.get = () => { throw new Error("Real network disabled for mock-only validation"); };
}
for (const name of ["node:net", "node:tls"]) {
  const m = require(name);
  m.connect = m.createConnection = () => { throw new Error("Real network disabled for mock-only validation"); };
}
