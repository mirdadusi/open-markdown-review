import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
// Keep production builds, provenance checks and profiles on the same backend.
// Do not alias strict JSON, schema validation, session or publication modules.
export const goCompanionBuildOptions={
  alias:{'@noble/hashes/sha256':path.join(root,'clients/companion-go/sha256.ts'),'linkify-it':path.join(root,'clients/companion-go/disabledLinkify.ts')},
};
/** A developer's global Go settings must not inject test tags, overlays or workspaces. */
export function goDistributionEnvironment(inherited) {
  return {...inherited,CGO_ENABLED:'0',GOTOOLCHAIN:'local',GOENV:'off',GOWORK:'off',
    // Dependency discovery also invokes Git unless VCS stamping is disabled.
    // Release provenance is recorded separately from the exact trusted checkout.
    GOFLAGS:'-buildvcs=false -mod=readonly -p=1',GOEXPERIMENT:'',GOAMD64:'v1',GOARM64:'v8.0'};
}
