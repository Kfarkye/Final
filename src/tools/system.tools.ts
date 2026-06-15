import { z } from "zod";
import { RegisteredTool } from "./types";

export const systemTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "get_current_time",
      description: "Returns the current date and time in ISO 8601 format.",
      schema: z.object({})
    },
    handler: () => {
      return {
        currentTime: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      };
    }
  },
  {
    definition: {
      name: "run_script",
      description: "Runs untrusted JavaScript code in a highly secure sandbox with strict memory and CPU limits. No network access.",
      schema: z.object({
        code: z.string().min(1, "Code cannot be empty")
      })
    },
    handler: async (args) => {
      const ivm = (await import("isolated-vm")).default;
      const logs: string[] = [];
      // 1. Create a strict Isolate with a 64MB memory limit
      const isolate = new ivm.Isolate({ memoryLimit: 64 });
      
      try {
        const context = await isolate.createContext();
        const jail = context.global;
        
        // 2. Set up a secure bridge to extract console logs
        // This Reference securely passes data across the V8 boundary
        const logCallback = new ivm.Reference((...msgArgs: any[]) => {
          logs.push(msgArgs.map(String).join(' '));
        });
        
        await jail.set('global', jail.derefInto());
        await context.evalClosure(`
          global.console = {
            log: function(...args) { $0.applyIgnored(undefined, args, { arguments: { copy: true } }); },
            error: function(...args) { $0.applyIgnored(undefined, args.map(a => "[ERROR] " + a), { arguments: { copy: true } }); },
            warn: function(...args) { $0.applyIgnored(undefined, args.map(a => "[WARN] " + a), { arguments: { copy: true } }); }
          };
        `, [logCallback], { arguments: { reference: true } });

        // 3. Compile the untrusted script
        const script = await isolate.compileScript(args.code);

        // 4. Run the script with strict Wall-clock timeouts to prevent `while(true)` freezes
        // The `copy: true` safely sanitizes the return value before giving it back to Node
        const result = await script.run(context, { timeout: 3000, copy: true });

        return {
          success: true,
          logs,
          result: typeof result === 'object' ? JSON.stringify(result) : String(result)
        };

      } catch (err: any) {
        return {
          success: false,
          error: `Sandbox execution failed: ${err.message}`,
          logs
        };
      } finally {
        // 5. CRITICAL: Always dispose of the isolate to free C++ memory and prevent memory leaks
        isolate.dispose();
      }
    }
  }
];
