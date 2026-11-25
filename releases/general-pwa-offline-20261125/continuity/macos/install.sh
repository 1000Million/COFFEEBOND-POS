#!/bin/bash
# Install on an approved managed Mac for one specified local till login. Browser policy is managed separately.
set -euo pipefail
umask 022
cd "$(dirname "$0")"
shasum -a 256 -c SHA256SUMS
if test "$(id -u)" != 0 || test "$#" != 1; then
  echo 'An administrator must specify the existing local till login as the sole argument.' >&2
  exit 1
fi
till_uid=$(id -u "$1")
test "$till_uid" -ge 501
support="/Library/Application Support/Coffee Bond/Session Clock"
manifest_dir="/Library/Google/Chrome/NativeMessagingHosts"
launch_dir="/Library/LaunchAgents"
base="$launch_dir/in.coffeebond.session-clock.plist"
domain="gui/$till_uid"
target="$support/session-clock"
install -d -m 0755 -o root -g wheel "$support" "$manifest_dir" "$launch_dir"
if test -e "$base" && test "$(/usr/bin/plutil -extract ProgramArguments.2 raw "$base")" != "$till_uid"; then
  echo 'The clock is already assigned to another login. Review the existing installation.' >&2
  exit 1
fi
if test -e "$target" && ! cmp -s session-clock "$target"; then
  echo 'A different session clock is installed. Reconcile pending bills and schedule a managed replacement before updating.' >&2
  exit 1
fi
install -m 0755 session-clock "$support/session-clock.new"
mv -f "$support/session-clock.new" "$target"
plist="$support/launch.new"
native="$support/host.new"
/usr/bin/plutil -create xml1 "$plist"
/usr/bin/plutil -insert Label -string in.coffeebond.session-clock "$plist"
/usr/bin/plutil -insert ProgramArguments -xml '<array/>' "$plist"
/usr/bin/plutil -insert ProgramArguments.0 -string "$target" "$plist"
/usr/bin/plutil -insert ProgramArguments.1 -string --serve-for "$plist"
/usr/bin/plutil -insert ProgramArguments.2 -string "$till_uid" "$plist"
/usr/bin/plutil -insert RunAtLoad -bool YES "$plist"
/usr/bin/plutil -insert KeepAlive -xml '<dict><key>SuccessfulExit</key><false/></dict>' "$plist"
/usr/bin/plutil -insert LimitLoadToSessionType -string Aqua "$plist"
/usr/bin/plutil -create xml1 "$native"
/usr/bin/plutil -insert name -string in.coffeebond.session_clock "$native"
/usr/bin/plutil -insert description -string 'Coffee Bond session clock' "$native"
/usr/bin/plutil -insert type -string stdio "$native"
/usr/bin/plutil -insert path -string "$target" "$native"
/usr/bin/plutil -insert allowed_origins -xml '<array/>' "$native"
/usr/bin/plutil -insert allowed_origins.0 -string 'chrome-extension://obhpkahmmhfkhmdbjlhggafhfbaaaemh/' "$native"
/usr/bin/plutil -convert json "$native"
mv -f "$native" "$manifest_dir/in.coffeebond.session_clock.json"
mv -f "$plist" "$base"
if ! launchctl print "$domain/in.coffeebond.session-clock" >/dev/null 2>&1; then
  launchctl bootstrap "$domain" "$base"
fi
echo 'Managed session clock installed for the selected login. Financial enrollment and permissions are separate.'
