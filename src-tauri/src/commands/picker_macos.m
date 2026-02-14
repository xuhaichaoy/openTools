/*
 * 直接取色 — 调用 macOS 系统 NSColorSampler，不截屏
 * 系统自带放大镜，点击后 stdout 输出 #RRGGBB
 * 编译: clang -framework Cocoa -o mtools_color_sampler picker_macos.m
 */
#import <Cocoa/Cocoa.h>
#include <math.h>

int main(int argc, char *argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSColorSampler *sampler = [[NSColorSampler alloc] init];
        [NSApp activateIgnoringOtherApps:YES];
        [sampler showSamplerWithSelectionHandler:^(NSColor * _Nullable color) {
            if (color) {
                NSColor *c = [color colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
                if (c) {
                    printf("#%02X%02X%02X",
                        (int)round(c.redComponent * 255.0),
                        (int)round(c.greenComponent * 255.0),
                        (int)round(c.blueComponent * 255.0));
                }
            }
            fflush(stdout);
            [NSApp terminate:nil];
        }];
        [NSApp run];
    }
    return 0;
}
