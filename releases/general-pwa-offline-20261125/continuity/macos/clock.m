// Compile with Foundation and AppKit. The broker never receives a bill, an identity or a token.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <CoreGraphics/CoreGraphics.h>
#include <sys/ucred.h>
#include <mach/mach_time.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

static NSString *epoch;
static double lastWall, lastTicks;
static BOOL sleeping, screenLocked, consoleActive;
static BOOL consoleAvailable(void) {
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    return session && [session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue] &&
           ![session[@"CGSSessionScreenIsLocked"] boolValue] && !sleeping && !screenLocked && consoleActive;
}
// The socket is user-private. Also verify that the kernel peer runs this same signed executable.
static NSData *codeDigest(SecCodeRef code) {
    if (!code || SecCodeCheckValidity(code, kSecCSDefaultFlags, NULL) != errSecSuccess) return nil;
    CFDictionaryRef raw = NULL;
    if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &raw) != errSecSuccess) return nil;
    NSDictionary *info = CFBridgingRelease(raw);
    return info[(__bridge NSString *)kSecCodeInfoUnique];
}
static BOOL sameBroker(int fd) {
    audit_token_t token; socklen_t len = sizeof(token); uid_t uid; gid_t gid;
    if (getpeereid(fd,&uid,&gid) || uid != getuid() || getsockopt(fd,SOL_LOCAL,LOCAL_PEERTOKEN,&token,&len) || len != sizeof(token)) return NO;
    SecCodeRef peer=NULL, own=NULL;
    NSDictionary *attributes=@{(__bridge NSString *)kSecGuestAttributeAudit:[NSData dataWithBytes:&token length:len]};
    SecCodeCopyGuestWithAttributes(NULL,(__bridge CFDictionaryRef)attributes,kSecCSDefaultFlags,&peer);
    SecCodeCopySelf(kSecCSDefaultFlags,&own);
    NSData *ours=codeDigest(own), *theirs=codeDigest(peer);
    if (peer) CFRelease(peer); if (own) CFRelease(own);
    return ours.length>0 && [ours isEqual:theirs];
}
static double ticks(void) {
    static mach_timebase_info_data_t info;
    if (!info.denom) mach_timebase_info(&info);
    return (double)mach_continuous_time() * info.numer / info.denom / 1000000.0;
}
static void reset(void) {
    epoch = [NSUUID UUID].UUIDString;
    lastWall = NSDate.date.timeIntervalSince1970 * 1000;
    lastTicks = ticks();
}
static void sample(void) {
    double now = ticks(), wall = NSDate.date.timeIntervalSince1970 * 1000;
    double gap = now - lastTicks;
    if (gap < 0 || gap > 30000 || fabs((wall - lastWall) - gap) > 1000) reset();
    lastTicks = now;
    lastWall = wall;
}
static BOOL writeAll(int fd, const void *data, size_t size) {
    const char *p = data;
    while (size) { ssize_t n = write(fd, p, size); if (n <= 0) return NO; size -= n; p += n; }
    return YES;
}
static BOOL readAll(int fd, void *data, size_t size) {
    char *p = data;
    while (size) { ssize_t n = read(fd, p, size); if (n <= 0) return NO; size -= n; p += n; }
    return YES;
}
static NSDictionary *readBroker(struct sockaddr_un *addr) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return nil;
    struct timeval timeout = {1, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    NSDictionary *result = nil;
    if (connect(fd, (struct sockaddr *)addr, sizeof(*addr)) == 0) {
        uint32_t size = 0;
        if (sameBroker(fd) && readAll(fd, &size, sizeof(size)) && size > 0 && size <= 1024) {
            NSMutableData *bytes = [NSMutableData dataWithLength:size];
            if (readAll(fd, bytes.mutableBytes, size)) result = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
        }
    }
    close(fd); return result;
}
static void reply(int fd, NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    uint32_t size = (uint32_t)data.length;
    if (writeAll(fd, &size, sizeof(size))) writeAll(fd, data.bytes, size);
}
static int serve(struct sockaddr_un *addr, NSString *folder) {
    if (mkdir(folder.fileSystemRepresentation, 0700) && errno != EEXIST) return 2;
    struct stat st;
    if (lstat(folder.fileSystemRepresentation, &st) || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 077)) return 2;
    // The lock serializes daemon ownership, including removal of a crashed daemon's socket.
    NSString *lock = [folder stringByAppendingPathComponent:@"clock.lock"];
    int guard = open(lock.fileSystemRepresentation, O_CREAT | O_NOFOLLOW | O_RDWR, 0600);
    if (guard < 0 || flock(guard, LOCK_EX | LOCK_NB) != 0) return 3;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return 2;
    unlink(addr->sun_path);
    if (bind(fd, (struct sockaddr *)addr, sizeof(*addr)) || listen(fd, 8)) return 2;
    fcntl(fd, F_SETFL, O_NONBLOCK);
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    consoleActive = [session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue];
    screenLocked = [session[@"CGSSessionScreenIsLocked"] boolValue];
    reset();
    NSNotificationCenter *workspace = NSWorkspace.sharedWorkspace.notificationCenter;
    NSDistributedNotificationCenter *system = NSDistributedNotificationCenter.defaultCenter;
    for (NSString *name in @[NSWorkspaceWillSleepNotification, NSWorkspaceDidWakeNotification,
            NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceSessionDidBecomeActiveNotification,
            @"com.apple.screenIsLocked", @"com.apple.screenIsUnlocked"]) {
        NSNotificationCenter *center = [name hasPrefix:@"com.apple."] ? system : workspace;
        [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            if ([note.name isEqual:NSWorkspaceWillSleepNotification]) sleeping=YES;
            if ([note.name isEqual:NSWorkspaceDidWakeNotification]) sleeping=NO;
            if ([note.name isEqual:NSWorkspaceSessionDidResignActiveNotification]) consoleActive=NO;
            if ([note.name isEqual:NSWorkspaceSessionDidBecomeActiveNotification]) consoleActive=YES;
            if ([note.name isEqual:@"com.apple.screenIsLocked"]) screenLocked=YES;
            if ([note.name isEqual:@"com.apple.screenIsUnlocked"]) screenLocked=NO;
            reset();
        }];
    }
    dispatch_source_t listener = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, fd, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(listener, ^{
        int client = accept(fd, NULL, NULL);
        if (client < 0) return;
        uid_t uid; gid_t gid; sample();
        if (getpeereid(client, &uid, &gid) == 0 && uid == getuid())
            reply(client, !consoleAvailable() ? @{@"available":@NO} : @{@"epoch":epoch, @"ticks":@(lastTicks)});
        close(client);
    });
    dispatch_resume(listener);
    [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *timer) { sample(); }];
    [NSRunLoop.mainRunLoop run];
    return 0;
}
int main(int argc, const char **argv) { @autoreleasepool {
    signal(SIGPIPE, SIG_IGN); umask(077);
    NSString *folder = [NSHomeDirectory() stringByAppendingPathComponent:@".coffee-bond-session-clock"];
#ifdef COFFEE_BOND_CLOCK_QUALIFICATION
    folder = NSProcessInfo.processInfo.environment[@"COFFEE_BOND_CLOCK_DIR"] ?: folder;
#endif
    NSString *path = [folder stringByAppendingPathComponent:@"broker.sock"];
    struct sockaddr_un addr = {0}; addr.sun_family = AF_UNIX;
    if (strlcpy(addr.sun_path, path.fileSystemRepresentation, sizeof(addr.sun_path)) >= sizeof(addr.sun_path)) return 2;
    if (argc == 3 && strcmp(argv[1], "--serve-for") == 0) {
        NSString *allowed = [NSString stringWithUTF8String:argv[2]];
        if (![allowed isEqualToString:[@(getuid()) stringValue]]) return 0;
        return serve(&addr, folder);
    }
#ifdef COFFEE_BOND_CLOCK_QUALIFICATION
    if (argc == 2 && strcmp(argv[1], "--serve") == 0) return serve(&addr, folder);
#endif
    uint32_t size = 0;
    if (!readAll(STDIN_FILENO, &size, sizeof(size)) || !size || size > 1024) return 1;
    NSMutableData *input = [NSMutableData dataWithLength:size];
    if (!readAll(STDIN_FILENO, input.mutableBytes, size)) return 1;
    NSDictionary *message = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
    if (![message isKindOfClass:NSDictionary.class] || ![message[@"action"] isEqual:@"SAMPLE"]) return 1;
    reply(STDOUT_FILENO, readBroker(&addr) ?: @{@"available":@NO});
    return 0;
}}
