using System;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

// Separate test entry point; never included in the shipped executable.
internal static class NativeUiPreview
{
    [STAThread]
    private static void Main(string[] args)
    {
        RenderOptions.ProcessRenderMode = System.Windows.Interop.RenderMode.SoftwareOnly;
        if (args.Length >= 1) Program.ConsolePort = Int32.Parse(args[0]);
        else {
            if (!System.IO.File.Exists(Program.ServicePortsPath)) throw new ArgumentException("Expected isolated fixture port");
            Program.LoadConsolePort();
        }
        App app = new App();
        MainWindow window = new MainWindow(false);
        int captureWidth = 0;
        int captureHeight = 0;
        string captureView = "";
        if (args.Length >= 3)
        {
            int requestedWidth = Int32.Parse(args[1]);
            int requestedHeight = Int32.Parse(args[2]);
            if (requestedWidth > 0) window.Width = Math.Min(requestedWidth, 1200);
            if (requestedHeight > 0) window.Height = Math.Min(requestedHeight, 900);
            captureWidth = requestedWidth;
            captureHeight = requestedHeight;
        }
        if (args.Length >= 4) captureView = args[3];
        bool inspectOnly = args.Length >= 5 && string.Equals(args[4], "inspect", StringComparison.OrdinalIgnoreCase);
        window.WindowStartupLocation = WindowStartupLocation.Manual;
        window.Left = 0;
        window.Top = 0;
        if (captureWidth <= 0 || captureHeight <= 0)
        {
            captureWidth = (int)Math.Ceiling(window.Width);
            captureHeight = (int)Math.Ceiling(window.Height);
        }
        System.IO.File.WriteAllText(System.IO.Path.Combine(Program.AppDataDir, "preview-start.txt"),
            window.Left + "," + window.Top + " " + window.Width + "x" + window.Height);
        DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        timer.Tick += async delegate {
            timer.Stop();
            System.IO.File.WriteAllText(System.IO.Path.Combine(Program.AppDataDir, "preview-window.txt"),
                window.IsVisible + " " + window.WindowState + " " + window.Left + "," + window.Top + " " + window.ActualWidth + "x" + window.ActualHeight);
            if (!string.IsNullOrWhiteSpace(captureView))
            {
                MethodInfo method = window.GetType().GetMethod("ShowGatewayWorkspace", BindingFlags.Instance | BindingFlags.NonPublic);
                if (method != null) method.Invoke(window, new object[] { captureView });
            }
            await System.Threading.Tasks.Task.Delay(350);
            window.UpdateLayout();
            var root = (FrameworkElement)window.Content;
            root.Width = captureWidth;
            root.Height = captureHeight;
            Panel panel = root as Panel;
            if (panel != null && panel.Background == null)
                panel.Background = new SolidColorBrush(Color.FromRgb(246, 248, 251));
            root.Measure(new Size(captureWidth, captureHeight));
            root.Arrange(new Rect(0, 0, captureWidth, captureHeight));
            root.UpdateLayout();
            System.IO.File.WriteAllText(
                System.IO.Path.Combine(Program.AppDataDir, "preview-debug.txt"),
                "root=" + root.ActualWidth + "x" + root.ActualHeight
                + " desired=" + root.DesiredSize
                + " render=" + root.RenderSize
                + " visible=" + root.IsVisible
                + " children=" + VisualTreeHelper.GetChildrenCount(root)
                + " window=" + window.ActualWidth + "x" + window.ActualHeight);
            var bitmap = new RenderTargetBitmap(captureWidth, captureHeight, 96, 96, PixelFormats.Pbgra32);
            var background = new DrawingVisual();
            using (var drawing = background.RenderOpen())
            {
                drawing.DrawRectangle(new SolidColorBrush(Color.FromRgb(246, 248, 251)), null, new Rect(0, 0, captureWidth, captureHeight));
            }
            bitmap.Render(background);
            bitmap.Render(root);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            string name = string.IsNullOrWhiteSpace(captureView) ? "native-preview.png" : "native-preview-" + captureView + ".png";
            using (var file = System.IO.File.Create(System.IO.Path.Combine(Program.AppDataDir, name))) encoder.Save(file);
            if (Application.Current != null) Application.Current.Shutdown();
        };
        if (!inspectOnly) timer.Start();
        app.Run(window);
    }
}
