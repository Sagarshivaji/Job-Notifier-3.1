import { app, initializeApp } from '../backend/server.js';

export default async function handler(req, res) {
  await initializeApp();
  return app(req, res);
}
