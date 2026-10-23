import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  fchmodSync,
  ftruncateSync,
  writeSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { getuid } from "node:process";
const invalid = () => Error("ACCOUNT_CREDENTIALS_INVALID");
export function readAccountCredentials(
  file,
  { accountId, owner = getuid?.(), parentOwner = owner } = {},
) {
  let fd, bytes;
  try {
    if (!isAbsolute(file) || realpathSync(file) !== file) throw invalid();
    const parent = lstatSync(dirname(file));
    if (
      !parent.isDirectory() ||
      (parent.mode & 0o777) !== 0o700 ||
      parent.uid !== parentOwner
    )
      throw invalid();
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== owner ||
      (st.mode & 0o777) !== 0o600 ||
      st.size > 4096
    )
      throw invalid();
    bytes = readFileSync(fd);
    if (bytes.length > 4096) throw invalid();
    const value = JSON.parse(bytes.toString("utf8"));
    if (
      !value ||
      Object.keys(value).sort().join(",") !==
        "accountId,auth,container,schema" ||
      value.schema !== "account_credentials@1" ||
      value.accountId !== accountId ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        accountId ?? "",
      ) ||
      typeof value.auth !== "string" ||
      typeof value.container !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.auth) ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.container)
    )
      throw invalid();
    return Object.freeze(value);
  } catch {
    throw invalid();
  } finally {
    if (fd !== undefined) closeSync(fd);
    bytes?.fill(0);
  }
}

/** Open before truncation; reject symlinks/hardlinks even when a previous runtime left a file. */
export function writeRuntimeAccountCredentials(file, credentials) {
  let fd;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600)
      throw invalid();
    fchmodSync(fd, 0o600);
    // Fixed-size canonical JSON; ftruncate follows validation of the already-open inode.
    const bytes = Buffer.from(JSON.stringify(credentials));
    try {
      ftruncateSync(fd, 0);
      writeSync(fd, bytes);
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw invalid();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
