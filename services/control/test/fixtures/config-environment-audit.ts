// Read only synthetic, private test configuration; never write credential values to output.
import { runtimeConfiguration } from "../../src/configuration";
const config = runtimeConfiguration();
const selected = Object.keys(config).filter(key => /TOKEN|SECRET|PASSWORD|_KEY$|DATABASE_URL/.test(key))
  .map(key => config[key]).filter((value): value is string => typeof value === "string");
const inspect = () => {
  if (Object.values(process.env).some(value => value !== undefined && selected.some(secret => value.includes(secret)))) {
    console.error("FIXTURE_CREDENTIAL_ENV_DETECTED"); process.exit(88);
  }
};
inspect();
setInterval(inspect, 10).unref();
