{
  description = "Home Assistant Add-on Development Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Container tools
            podman
            podman-compose
            
            # Home Assistant development tools
            hadolint  # Dockerfile linter
            curl      # For testing endpoints
            jq        # JSON processing
            
            # Build and validation tools
            git
            bash
            
            # Optional: useful for debugging
            yq-go     # YAML processing
          ];

          shellHook = ''
            echo "🏠 Home Assistant Add-on Development Environment"
            echo "Available commands:"
            echo "  build-addon     - Build the Codex Terminal Pro add-on"
            echo "  run-addon       - Run the add-on locally"  
            echo "  validate-addon  - Validate add-on structure"
            echo "  lint-dockerfile - Lint the Dockerfile"
            echo "  test-endpoint   - Test add-on web endpoint"
            echo ""
            echo "To get started: build-addon"
            
            # Create convenience aliases
            alias build-addon='podman build -t local/codex-terminal-pro ./codex-terminal'
            alias run-addon='podman run -p 7680:7680 -p 7681:7681 -v $(pwd)/config:/config -v /tmp/codex-terminal-data:/data local/codex-terminal-pro'
            alias validate-addon='echo "Note: Home Assistant builder validation requires HA OS environment"'
            alias lint-dockerfile='hadolint ./codex-terminal/Dockerfile'
            alias test-endpoint='curl -X GET http://localhost:7681/ || echo "Add-on not running. Use: run-addon"'
          '';
        };
      });
}
