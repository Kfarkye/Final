import { Artifact } from "../contracts/artifact";
import { PatchSet } from "../contracts/patch";
import { log } from "../obs/log";
                { patchsetDomain: set.domain, blockDomain: p.block.domain, blockId: p.block.id },
                "PatchEngine domain mismatch, skipping block"
              );