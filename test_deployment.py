from aura.core.artifact_provisioning_pipeline import ArtifactProvisioningPipeline
from aura.governance.enterprise_governance_service import EnterpriseGovernanceService
import json

def run_checks():
    pipeline = ArtifactProvisioningPipeline()
    
    unprivileged_principal = {"principal_id": "test_hacker", "roles": ["viewer"]}
    raw_manifest = {
        "deployment_id": "secret-deploy-001",
        "sensitivity_level": "HIGH",
        "personal_email": "topsecret@enterprise.com",
        "authentication_token": "bearer xyz123"
    }
    
    print("Test 1: Unprivileged deployment request...")
    try:
        pipeline.provision_artifact_for_deployment(raw_manifest, unprivileged_principal)
        print("FAIL: PermissionError was not raised!")
    except PermissionError as e:
        print("PASS: Deployment denied with PermissionError as expected.")
        print("Error message:", e)
        
    print("\nTest 2: Privileged deployment and data redaction...")
    privileged_principal = {"principal_id": "deploy_admin", "roles": ["release_manager"]}
    
    try:
        governed_manifest = pipeline.provision_artifact_for_deployment(raw_manifest, privileged_principal)
        print("PASS: Deployment succeeded.")
        
        # Check redaction
        if governed_manifest.get("personal_email") == "[ENTERPRISE_REDACTED_BY_POLICY]":
            print("PASS: personal_email redacted.")
        else:
            print("FAIL: personal_email not redacted! Value:", governed_manifest.get("personal_email"))
            
        if governed_manifest.get("authentication_token") == "[ENTERPRISE_REDACTED_BY_POLICY]":
            print("PASS: authentication_token redacted.")
        else:
            print("FAIL: authentication_token not redacted! Value:", governed_manifest.get("authentication_token"))
            
    except Exception as e:
        print("FAIL: Unexpected error during privileged deployment:", e)

if __name__ == "__main__":
    run_checks()
