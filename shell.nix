{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  packages = with pkgs; [
    bun # runtime + package manager; runs TS directly, ships bun:sqlite
    sqlite # CLI, handy for poking at data/ircmcp.db
  ];
}
