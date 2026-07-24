require("dotenv").config();
const { OPCUAClient, AttributeIds } = require("node-opcua");
const stations = require("./station");

const endpoint = process.env.OPC_ENDPOINT || "opc.tcp://localhost:59100";
const nodeId = stations.NorthLock?.UpStream; // confirmed-configured tag this time

(async () => {
  console.log("Node:", process.version);
  console.log("Reading nodeId:", nodeId);
  if (!nodeId) {
    console.log("Still undefined - paste your station.js so I pick a real key name instead of guessing.");
    return;
  }

  const client = OPCUAClient.create({ endpointMustExist: false });
  await client.connect(endpoint);
  console.log("connect() ok");

  const session = await client.createSession();
  console.log("createSession() ok");

  console.log("calling session.read() - waiting up to 30s, no artificial timeout...");
  const start = Date.now();
  try {
    const result = await session.read([{ nodeId, attributeId: AttributeIds.Value }]);
    console.log("read() resolved after", Date.now() - start, "ms");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log("read() rejected after", Date.now() - start, "ms");
    console.error(err);
  }

  await session.close();
  await client.disconnect();
})();