import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";
import type { PyInstallerCookie } from "./CArchiveLayout.js";

/** Validated cookie facts borrowed with the descriptor that produced them. */
export interface PyInstallerAdmission {
  readonly kind: "pyinstaller";
  readonly source: StableRegularFileDescriptor;
  readonly cookie: PyInstallerCookie;
}
