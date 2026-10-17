using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

internal static class ClientThemeRegression
{
    private static void Require(bool value, string message)
    {
        if (!value) throw new Exception(message);
    }

    private static void Flush()
    {
        Dispatcher.CurrentDispatcher.Invoke(DispatcherPriority.ApplicationIdle, new Action(delegate {}));
    }

    [STAThread]
    private static void Main()
    {
        // Reproduce the original failure: sealing a style freezes its plain brush.
        SolidColorBrush original = new SolidColorBrush(Colors.White);
        Style oldStyle = new Style(typeof(Button));
        oldStyle.Setters.Add(new Setter(Control.BackgroundProperty, original));
        oldStyle.Seal();
        Require(original.IsFrozen, "The original frozen-brush failure was not reproduced");
        bool failed = false;
        try { original.Color = Colors.Black; } catch (InvalidOperationException) { failed = true; }
        Require(failed, "Original theme mutation should fail");

        ClientThemePalette palette = new ClientThemePalette();
        Application app = new Application();
        foreach (string name in new string[] { "App", "Card", "Text", "Muted", "Border", "Accent", "AccentText", "Surface", "PrimarySoft" })
            app.Resources["Client" + name] = palette.Brush(name);
        ClientUiStyles.Install(app.Resources);
        TabControl tabs = new TabControl();
        Expander expander = new Expander { Header = "Settings", Content = new TextBox { Text = "Saved settings" }, IsExpanded = true };
        tabs.Items.Add(new TabItem { Header = "Tunnels", Content = expander });
        tabs.Items.Add(new TabItem { Header = "Domain", Content = new CheckBox { Content = "Enabled", IsChecked = true } });
        tabs.Measure(new Size(800, 400)); tabs.Arrange(new Rect(0, 0, 800, 400)); tabs.UpdateLayout();
        Require(tabs.Template != null && expander.Template != null, "Product templates were not applied");
        Require(((TabItem)tabs.Items[0]).FontWeight == FontWeights.Normal, "Selected tab bold leaked into all page content");
        Require(((SolidColorBrush)((TabItem)tabs.Items[0]).Foreground).Color == palette.Brush("Text").Color, "Tab header accent leaked into page content");
        TextBox input = new TextBox { Text = "中文分组", Width = 148, Height = 34, Style = (Style)app.FindResource(typeof(TextBox)) };
        input.ApplyTemplate();
        input.Measure(new Size(148, 34)); input.Arrange(new Rect(0, 0, 148, 34)); input.UpdateLayout();
        ScrollViewer host = (ScrollViewer)input.Template.FindName("PART_ContentHost", input);
        Require(!host.Focusable && host.Margin == new Thickness(0), "Editor host steals focus or duplicates padding");
        Rect glyph = input.GetRectFromCharacterIndex(0);
        Require(!glyph.IsEmpty && glyph.Height >= input.FontSize, "Fixed-height input clips its text");
        Button primary = new Button { Background = palette.Brush("Accent"), Foreground = Brushes.White, Content = "Save" };
        primary.Measure(new Size(160, 36)); primary.Arrange(new Rect(0, 0, 160, 36)); primary.UpdateLayout();
        SolidColorBrush card = palette.Brush("Card");
        Style style = new Style(typeof(Button));
        style.Setters.Add(new Setter(Control.BackgroundProperty, card));
        style.Setters.Add(new Setter(Control.ForegroundProperty, palette.Brush("Text")));
        style.Seal();
        Button button = new Button { Style = style, Content = "Theme test" };
        Border panel = new Border { Background = palette.Brush("App"), Child = button };
        panel.Measure(new Size(400, 200));
        panel.Arrange(new Rect(0, 0, 400, 200));
        button.ApplyTemplate();
        Flush();

        for (int i = 0; i < 20; i++) {
            bool dark = i % 2 == 0;
            palette.Apply(dark);
            Flush();
            tabs.SelectedIndex = i % 2;
            tabs.UpdateLayout();
            Require(primary.Foreground == Brushes.White, "Primary action lost readable text");
            Require(((SolidColorBrush)primary.Background).Color.ToString() == "#FF2563EB", "Primary action contrast drifted");
            Require(palette.IsDark == dark, "Theme selection did not update");
            Require(!card.IsFrozen && !card.CanFreeze, "Live themed brush was frozen");
            // WPF may clone an expression-backed Freezable per styled control.
            Require(((SolidColorBrush)button.Background).Color == card.Color, "Existing styled control used a stale brush");
            Require(card.Color.ToString() == (dark ? "#FF1E293B" : "#FFFFFFFF"), "Existing card did not update");
            Require(((SolidColorBrush)button.Foreground).Color.ToString() == (dark ? "#FFF1F5F9" : "#FF0F172A"), "Text did not follow theme");
            Require(((SolidColorBrush)panel.Background).Color.ToString() == (dark ? "#FF111827" : "#FFF6F8FB"), "Panel did not follow theme");
            Button later = new Button { Style = style };
            Require(((SolidColorBrush)later.Background).Color == card.Color, "New control used stale theme");
        }
        Console.WriteLine("PASS: frozen-brush reproduction and 20 rendered-style theme switches");
    }
}
