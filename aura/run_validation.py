import json
from governance.enterprise_governance_service import EnterpriseGovernanceService, DataIntegrityEnforcer, AccessControlEnforcer

class ArtifactProvisioningPipeline:
    def __init__(self):
        self.enterprise_governance_service = EnterpriseGovernanceService()

    def provision_artifact_for_deployment(self, raw_artifact_manifest, deployer_principal=None):
        action_context = {
            "action_requested": "deploy_critical",
            "resource_identifier": {
                "type": "production_artifact",
                "name": raw_artifact_manifest.get("deployment_id", "UNSPECIFIED_DEPLOYMENT"), 
                "sensitivity": raw_artifact_manifest.get("sensitivity_level", "STANDARD")
            }
        }
        
        try:
            governed_artifact_manifest = self.enterprise_governance_service.apply_governance_policies(
                raw_artifact_manifest, 
                principal_context=deployer_principal, 
                action_context=action_context
            )
            return governed_artifact_manifest
        except (PermissionError, ValueError) as e:
            self.enterprise_governance_service._record_audit_event(
                "artifact_deployment_provision_failed", 
                {"reason": str(e), "deployment_id": raw_artifact_manifest.get("deployment_id", "N/A"), 
                 "principal_id": deployer_principal.get("principal_id", "N/A")}
            )
            raise

def main():
    pipeline = ArtifactProvisioningPipeline()
    
    # Simulate unprivileged deployer_principal and HIGH sensitivity resource
    unprivileged_principal = {"principal_id": "unprivileged_user", "roles": ["developer"]}
    artifact_manifest = {
        "deployment_id": "sensitive-deployment-123",
        "sensitivity_level": "HIGH",
        "personal_email": "test@enterprise.com",
        "authentication_token": "secret_token_abc"
    }
    
    try:
        pipeline.provision_artifact_for_deployment(artifact_manifest, unprivileged_principal)
        print("ERROR: Deployment should have been denied with a PermissionError.")
    except PermissionError as e:
        print(f"SUCCESS: Deployment explicitly denied: {e}")
        
    # Now simulate a successful deployment to check redaction
    privileged_principal = {"principal_id": "admin_user", "roles": ["global_administrator"]}
    
    try:
        deployed_artifact = pipeline.provision_artifact_for_deployment(artifact_manifest, privileged_principal)
        print("\nSUCCESS: Deployed artifact manifest:")
        print(json.dumps(deployed_artifact, indent=2))
        
        # Verify redaction
        if deployed_artifact.get("personal_email") == DataIntegrityEnforcer.REDACTION_TOKEN and \
           deployed_artifact.get("authentication_token") == DataIntegrityEnforcer.REDACTION_TOKEN:
            print("SUCCESS: Sensitive fields successfully transformed to [ENTERPRISE_REDACTED_BY_POLICY]")
        else:
            print("ERROR: Sensitive fields were not redacted correctly.")
            
    except Exception as e:
        print(f"ERROR: Unexpected exception during successful deployment simulation: {e}")
        
    print("\n--- AUDIT LOGS ---")
    for log in pipeline.enterprise_governance_service.audit_log_stream:
        print(json.dumps(log, indent=2))

if __name__ == "__main__":
    main()
