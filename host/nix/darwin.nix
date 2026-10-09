# nix-darwin module: networth-host as a kept-alive launchd user agent that
# long-polls the Networth site for finance review runs and launches an agent
# for each in a new Herdr tab. The site never connects to this machine.
#
# Runs in the login session (gui/<uid>) so the default credential lookup can
# read the login Keychain, which ssh-descended shells cannot.
self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.networth-host;
  environment = {
    NETWORTH_URL = cfg.url;
    NETWORTH_HOST_STATE_DIR = cfg.stateDir;
    NETWORTH_HOST_HERDR_SESSION = cfg.herdrSession;
    NETWORTH_HOST_POLL_SECONDS = toString cfg.pollSeconds;
  }
  // lib.optionalAttrs (cfg.herdrWorkspace != null) {
    NETWORTH_HOST_HERDR_WORKSPACE = cfg.herdrWorkspace;
  }
  // lib.optionalAttrs (cfg.tokenCommand != [ ]) {
    NETWORTH_HOST_TOKEN_COMMAND = builtins.toJSON cfg.tokenCommand;
  };
  # The CLI with this machine's settings baked in, so `enroll` and the agent's
  # `report` use the same site and state directory as the daemon.
  wrapper = pkgs.writeShellScriptBin "networth-host" ''
    ${lib.concatStrings (lib.mapAttrsToList (k: v: "export ${k}=${lib.escapeShellArg v}\n") environment)}
    exec ${lib.getExe cfg.package} "$@"
  '';
in
{
  options.services.networth-host = {
    enable = lib.mkEnableOption "launching finance review agents for runs started on a Networth site";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "The networth-host package.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      description = "Login user whose session runs the agent and its Herdr server.";
      example = "local-user";
    };

    url = lib.mkOption {
      type = lib.types.str;
      description = "HTTPS origin of the Networth site.";
      example = "https://networth.example.workers.dev";
    };

    tokenCommand = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        argv printing this host's credential. Empty reads the login Keychain item
        that `networth-host enroll` saves. Never put the credential itself in Nix.
      '';
    };

    herdrSession = lib.mkOption {
      type = lib.types.str;
      default = "default";
      description = "Herdr server session that receives the agent tabs.";
    };

    herdrWorkspace = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Herdr workspace id for new tabs (default: Herdr's choice).";
      example = "w1";
    };

    pollSeconds = lib.mkOption {
      type = lib.types.ints.between 0 25;
      default = 25;
      description = "How long the site holds each claim request open. Pickup latency is about 2 s either way.";
    };

    path = lib.mkOption {
      type = lib.types.str;
      default = "/etc/profiles/per-user/${cfg.user}/bin:/run/current-system/sw/bin:/usr/bin:/bin";
      defaultText = lib.literalExpression ''"/etc/profiles/per-user/''${user}/bin:/run/current-system/sw/bin:/usr/bin:/bin"'';
      description = "PATH for the daemon; must contain herdr.";
    };

    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "/Users/${cfg.user}/.local/state/networth-host";
      defaultText = lib.literalExpression ''"/Users/''${user}/.local/state/networth-host"'';
      description = "Enrollment receipt, queued agent reports and the log.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ wrapper ];

    system.activationScripts.postActivation.text = lib.mkAfter ''
      # launchd opens StandardOutPath before the job runs.
      /usr/bin/sudo -u ${lib.escapeShellArg cfg.user} /bin/mkdir -p ${lib.escapeShellArg cfg.stateDir}
    '';

    launchd.user.agents.networth-host.serviceConfig = {
      Label = "networth-host";
      ProgramArguments = [
        "${wrapper}/bin/networth-host"
        "run"
      ];
      EnvironmentVariables = {
        HOME = "/Users/${cfg.user}";
        PATH = cfg.path;
      };
      RunAtLoad = true;
      KeepAlive = true;
      # A crashing daemon restarts at most every 30 s; it backs off on its own otherwise.
      ThrottleInterval = 30;
      ProcessType = "Background";
      WorkingDirectory = cfg.stateDir;
      StandardOutPath = "${cfg.stateDir}/networth-host.log";
      StandardErrorPath = "${cfg.stateDir}/networth-host.log";
    };
  };
}
