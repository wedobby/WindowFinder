// Finder Sync extension for WindowFinder.
// Adds "WindowFinder로 열기" to Finder's item, background, and sidebar menus.

#import <Cocoa/Cocoa.h>
#import <FinderSync/FinderSync.h>
#import <os/log.h>

// NSExtensionMain is exported by Foundation, but is not declared in the public
// SDK headers used by the standalone clang build in build.sh.
extern int NSExtensionMain(int argc, const char *argv[]);

@interface WindowFinderSync : FIFinderSync
@end

@implementation WindowFinderSync

static os_log_t WindowFinderLog(void) {
    static os_log_t log;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        log = os_log_create("com.wedobby.windowfinder.findersync", "FinderMenu");
    });
    return log;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        // Finder Sync can be unreliable when the filesystem root itself is the
        // only monitored URL. NSHomeDirectory() points at the extension's
        // sandbox, so construct the login user's actual home path explicitly.
        NSString *userHome = [@"/Users" stringByAppendingPathComponent:NSUserName()];
        NSArray<NSString *> *paths = @[
            userHome, @"/Applications", @"/System/Applications",
            @"/Users/Shared", @"/Volumes"
        ];
        NSMutableSet<NSURL *> *roots = [NSMutableSet setWithCapacity:paths.count];
        for (NSString *path in paths) {
            [roots addObject:[NSURL fileURLWithPath:path isDirectory:YES]];
        }
        FIFinderSyncController.defaultController.directoryURLs = roots;
        os_log_info(WindowFinderLog(), "started; roots=%{public}@", roots.description);
    }
    return self;
}

- (NSMenu *)menuForMenuKind:(FIMenuKind)kind {
    if (kind != FIMenuKindContextualMenuForItems &&
        kind != FIMenuKindContextualMenuForContainer &&
        kind != FIMenuKindContextualMenuForSidebar) {
        return nil;
    }

    FIFinderSyncController *controller = FIFinderSyncController.defaultController;
    NSArray<NSURL *> *urls = nil;

    if (kind == FIMenuKindContextualMenuForItems) {
        urls = controller.selectedItemURLs;
    }
    if (urls.count == 0) {
        NSURL *target = controller.targetedURL;
        if (target != nil) {
            urls = @[target];
        }
    }
    if (urls.count == 0) {
        os_log_info(WindowFinderLog(), "menu kind=%lu has no target", (unsigned long)kind);
        return nil;
    }

    os_log_info(WindowFinderLog(), "menu kind=%lu urls=%lu", (unsigned long)kind,
                (unsigned long)urls.count);

    NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
    NSMenuItem *item = [[NSMenuItem alloc]
        initWithTitle:@"WindowFinder로 열기"
                action:@selector(openInWindowFinder:)
         keyEquivalent:@""];
    [menu addItem:item];
    return menu;
}

- (void)openInWindowFinder:(NSMenuItem *)sender {
    // Finder transports the menu across its extension boundary and routes the
    // selector back to this principal object. Keep the NSMenuItem target nil
    // and query the controller again here, as Apple's Finder Sync template does.
    FIFinderSyncController *controller = FIFinderSyncController.defaultController;
    NSArray<NSURL *> *urls = controller.selectedItemURLs;
    if (urls.count == 0) {
        NSURL *target = controller.targetedURL;
        if (target != nil) {
            urls = @[target];
        }
    }
    if (urls.count == 0) {
        os_log_error(WindowFinderLog(), "action has no target URL");
        return;
    }

    // Finder Sync extensions are sandboxed. Opening the containing .app path
    // directly can fail with permErr. Pass paths through our URL scheme so
    // LaunchServices can deliver them without direct bundle/file access.
    NSURLComponents *components = [[NSURLComponents alloc] init];
    components.scheme = @"windowfinder";
    components.host = @"open";
    NSMutableArray<NSURLQueryItem *> *queryItems =
        [NSMutableArray arrayWithCapacity:urls.count];
    for (NSURL *url in urls) {
        if (url.isFileURL) {
            [queryItems addObject:[NSURLQueryItem queryItemWithName:@"path"
                                                              value:url.path]];
        }
    }
    components.queryItems = queryItems;
    NSURL *launchURL = components.URL;
    if (launchURL == nil || queryItems.count == 0) {
        os_log_error(WindowFinderLog(), "could not construct launch URL");
        return;
    }

    os_log_info(WindowFinderLog(), "opening app with %lu path(s)",
                (unsigned long)queryItems.count);

    NSWorkspaceOpenConfiguration *configuration =
        [NSWorkspaceOpenConfiguration configuration];
    configuration.activates = YES;
    configuration.addsToRecentItems = NO;
    [NSWorkspace.sharedWorkspace
        openURL:launchURL
        configuration:configuration
        completionHandler:^(NSRunningApplication *app, NSError *error) {
            if (error != nil) {
                os_log_error(WindowFinderLog(), "open failed: %{public}@", error.description);
            } else {
                os_log_info(WindowFinderLog(), "open succeeded; pid=%d", app.processIdentifier);
            }
        }];
}

@end

int main(int argc, const char *argv[]) {
    return NSExtensionMain(argc, argv);
}
