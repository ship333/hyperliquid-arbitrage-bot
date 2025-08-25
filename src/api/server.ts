import { app } from "./app";

const port = Number(process.env.TS_API_PORT || 8082);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`TS eval server listening on http://127.0.0.1:${port}`);
});
