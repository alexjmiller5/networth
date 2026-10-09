{
  description = "networth-host: picks up Networth finance review runs and launches an agent for each in Herdr (outbound long poll)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: {
        default = pkgs.python3Packages.buildPythonApplication {
          pname = "networth-host";
          version = "0.1.0";
          pyproject = true;
          src = nixpkgs.lib.cleanSource ./.;
          build-system = [ pkgs.python3Packages.setuptools ];
          nativeCheckInputs = [ pkgs.python3Packages.pytestCheckHook ];
          # The API tests talk to a throwaway HTTP server on 127.0.0.1.
          __darwinAllowLocalNetworking = true;
          meta.mainProgram = "networth-host";
        };
      });

      darwinModules.default = import ./nix/darwin.nix self;
    };
}
