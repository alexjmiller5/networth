{
  description = "Networth outbound host companion";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/8d5d270900d3fc75655ea2d9d248b234f6631439";
  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in {
      packages = eachSystem (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in {
          default = pkgs.python3Packages.buildPythonApplication {
            pname = "networth-host";
            version = "0.1.0";
            src = nixpkgs.lib.cleanSourceWith {
              src = ./.;
              filter = path: type: !(builtins.elem (baseNameOf path) [
                ".venv" "dist" "__pycache__" ".ruff_cache" "networth_host.egg-info"
              ]);
            };
            pyproject = true;
            build-system = [ pkgs.python3Packages.setuptools ];
            dependencies = [ pkgs.python3Packages.keyring ];
            nativeCheckInputs = [ pkgs.python3Packages.setuptools ];
            checkPhase = ''
              PYTHONPATH=. python -m unittest discover -s tests
            '';
            pythonImportsCheck = [ "networth_host" ];
            meta.mainProgram = "networth-host";
          };
        });
      homeModules.default = { config, lib, pkgs, ... }: {
        options.programs.networth-host.enable = lib.mkEnableOption "Networth host companion";
        config = lib.mkIf config.programs.networth-host.enable {
          home.packages = [ self.packages.${pkgs.stdenv.hostPlatform.system}.default ];
        };
      };
    };
}
