import json
import os

transcript_path = '/Users/k.far.88/.gemini/antigravity-ide/brain/ab0f30af-e710-4d44-b328-6eb3d8dec799/.system_generated/logs/transcript.jsonl'
file_states = {}

try:
    with open(transcript_path, 'r', encoding='utf-8') as f:
        for line in f:
            try:
                entry = json.loads(line)
                if 'tool_calls' in entry:
                    for call in entry['tool_calls']:
                        args = {}
                        for k, v in call.get('args', {}).items():
                            if isinstance(v, str):
                                try:
                                    args[k] = json.loads(v)
                                except:
                                    args[k] = v
                            else:
                                args[k] = v

                        target = args.get('TargetFile')
                        
                        if not target or '.gemini/antigravity-ide/brain/' in target or "extract.py" in target or "recover.py" in target:
                            continue
                            
                        # Initialize if not seen
                        if target not in file_states:
                            if os.path.exists(target):
                                with open(target, 'r', encoding='utf-8') as tf:
                                    file_states[target] = tf.read()
                            else:
                                file_states[target] = ""

                        if call['name'] == 'write_to_file':
                            file_states[target] = args.get('CodeContent', '')
                        elif call['name'] == 'replace_file_content':
                            start = int(args.get('StartLine'))
                            end = int(args.get('EndLine'))
                            replacement = args.get('ReplacementContent', '')
                            
                            lines = file_states[target].split('\n')
                            prefix = '\n'.join(lines[:start-1])
                            suffix = '\n'.join(lines[end:])
                            file_states[target] = (prefix + '\n' if prefix else '') + replacement + ('\n' + suffix if suffix else '')
                        elif call['name'] == 'multi_replace_file_content':
                            chunks = args.get('ReplacementChunks', [])
                            if isinstance(chunks, str):
                                chunks = json.loads(chunks)
                            
                            chunks.sort(key=lambda x: int(x['StartLine']), reverse=True)
                            content = file_states[target]
                            
                            for chunk in chunks:
                                start = int(chunk['StartLine'])
                                end = int(chunk['EndLine'])
                                repl = chunk.get('ReplacementContent', '')
                                
                                lines = content.split('\n')
                                prefix = '\n'.join(lines[:start-1])
                                suffix = '\n'.join(lines[end:])
                                content = (prefix + '\n' if prefix else '') + repl + ('\n' + suffix if suffix else '')
                            
                            file_states[target] = content
            except json.JSONDecodeError:
                pass
except Exception as e:
    print(f"Error: {e}")

for target, content in file_states.items():
    if "reverie" in target:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Restored {target}")
