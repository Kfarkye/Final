import sys
import json
import os
from enterprise_governance_service import EnterpriseGovernanceService

def main():
    try:
        # Read payload from stdin
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({"error": "No input provided to governance CLI"}))
            sys.exit(1)
            
        payload = json.loads(input_data)
        
        # Initialize service
        service = EnterpriseGovernanceService()
        
        # For this CLI, we will pass a default service account context 
        # unless one is provided in the payload structure.
        # To keep it simple, we'll assume the payload itself is what needs policy application.
        # If the tool passes { "_principal": {...}, "_action": {...}, "payload": {...} }, we parse it.
        
        principal_context = {"principal_id": "system_mcp_tool", "roles": ["global_administrator"]}
        action_context = {
            "action_requested": "process_payload",
            "resource_identifier": {"type": "mcp_tool_payload", "name": "drip_live_payload", "sensitivity": "STANDARD"}
        }
        
        if isinstance(payload, dict) and "_principal" in payload and "payload" in payload:
            principal_context = payload.get("_principal", principal_context)
            action_context = payload.get("_action", action_context)
            operational_payload = payload.get("payload", {})
        else:
            operational_payload = payload

        # Apply policies
        governed_payload = service.apply_governance_policies(
            operational_payload, 
            principal_context=principal_context, 
            action_context=action_context
        )
        
        print(json.dumps({
            "status": "success",
            "governed_payload": governed_payload
        }))
        
    except PermissionError as pe:
        print(json.dumps({
            "status": "error",
            "error_type": "PermissionError",
            "message": str(pe)
        }))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            "status": "error",
            "error_type": "SystemError",
            "message": str(e)
        }))
        sys.exit(1)

if __name__ == "__main__":
    main()
