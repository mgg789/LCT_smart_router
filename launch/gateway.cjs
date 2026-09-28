'use strict';
// Fixed upstream TCP ingress: API remains on the internal offline Docker network.
const net = require('node:net');
const server = net.createServer((client) => {
  const upstream = net.connect(8000, 'api');
  client.setTimeout(120000, () => client.destroy());
  upstream.setTimeout(120000, () => upstream.destroy());
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.pipe(upstream).pipe(client);
});
server.maxConnections = 128;
server.listen(8000, '0.0.0.0');
