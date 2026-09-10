// src/log.ts — Pi 环境无 OpenCode client.app.log，全部走 console
export interface Logger { debug(m:string, extra?:object):void; info(m:string, extra?:object):void; warn(m:string, extra?:object):void; error(m:string, extra?:object):void; }
export function createLogger(prefix = "codebuddy"): Logger {
  const sink = (level:string, message:string, extra?:object) => {
    const line = `[${prefix}] ${level}: ${message}`;
    if (level==="warn"||level==="error") console.error(line, extra ?? "");
    else if (level==="info") console.log(line, extra ?? "");
  };
  return { debug:()=>{}, info:(m,e)=>sink("info",m,e), warn:(m,e)=>sink("warn",m,e), error:(m,e)=>sink("error",m,e) };
}
