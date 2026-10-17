using System.Windows;
using System.Windows.Markup;
using System.Windows.Media;

internal static class ClientUiStyles
{
    internal static readonly FontFamily Font = new FontFamily("Microsoft YaHei UI, Segoe UI");
    internal static Brush MutedBrush { get { return (Brush)Application.Current.Resources["ClientMuted"]; } }

    internal static void ConfigureWindow(Window window)
    {
        window.FontFamily = Font;
        window.FontSize = 13;
        window.SetResourceReference(Window.BackgroundProperty, "ClientCard");
        window.SetResourceReference(Window.ForegroundProperty, "ClientText");
        window.UseLayoutRounding = true;
        window.SnapsToDevicePixels = true;
    }

    internal static void Install(ResourceDictionary resources)
    {
        resources["ClientFont"] = Font;
        resources.MergedDictionaries.Add((ResourceDictionary)XamlReader.Parse(Templates));
    }

    private const string Templates = @"
<ResourceDictionary xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml'>
  <Style TargetType='TextBlock'>
    <Setter Property='FontFamily' Value='{DynamicResource ClientFont}'/>
    <Setter Property='FontSize' Value='13'/>
  </Style>
  <Style x:Key='ClientControl' TargetType='Control'>
    <Setter Property='FontFamily' Value='{DynamicResource ClientFont}'/>
    <Setter Property='FontSize' Value='13'/>
    <Setter Property='Foreground' Value='{DynamicResource ClientText}'/>
    <Setter Property='Background' Value='{DynamicResource ClientCard}'/>
    <Setter Property='BorderBrush' Value='{DynamicResource ClientBorder}'/>
    <Setter Property='BorderThickness' Value='1'/>
    <Setter Property='SnapsToDevicePixels' Value='True'/>
  </Style>
  <Style TargetType='Button' BasedOn='{StaticResource ClientControl}'>
    <Setter Property='Height' Value='36'/><Setter Property='Padding' Value='14,0'/>
    <Setter Property='Cursor' Value='Hand'/>
    <Setter Property='HorizontalContentAlignment' Value='Center'/>
    <Setter Property='VerticalContentAlignment' Value='Center'/>
    <Setter Property='Template'>
      <Setter.Value><ControlTemplate TargetType='Button'>
        <Border x:Name='Chrome' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}' BorderThickness='{TemplateBinding BorderThickness}' CornerRadius='6'>
          <Grid>
            <Border x:Name='Hover' Background='{DynamicResource ClientText}' Opacity='0' CornerRadius='5'/>
            <ContentPresenter Margin='{TemplateBinding Padding}' HorizontalAlignment='{TemplateBinding HorizontalContentAlignment}' VerticalAlignment='{TemplateBinding VerticalContentAlignment}' RecognizesAccessKey='True'/>
          </Grid>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='Hover' Property='Opacity' Value='0.055'/></Trigger>
          <Trigger Property='IsPressed' Value='True'><Setter TargetName='Hover' Property='Opacity' Value='0.12'/></Trigger>
          <Trigger Property='IsKeyboardFocused' Value='True'><Setter TargetName='Chrome' Property='BorderBrush' Value='{DynamicResource ClientAccentText}'/></Trigger>
          <Trigger Property='IsEnabled' Value='False'><Setter TargetName='Chrome' Property='Opacity' Value='0.45'/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value>
    </Setter>
    <Style.Triggers><Trigger Property='IsDefault' Value='True'><Setter Property='Background' Value='{DynamicResource ClientAccent}'/><Setter Property='Foreground' Value='White'/><Setter Property='BorderBrush' Value='{DynamicResource ClientAccent}'/></Trigger></Style.Triggers>
  </Style>
  <Style TargetType='ContextMenu' BasedOn='{StaticResource ClientControl}'><Setter Property='Padding' Value='6'/></Style>
  <Style TargetType='MenuItem' BasedOn='{StaticResource ClientControl}'><Setter Property='Background' Value='Transparent'/><Setter Property='BorderThickness' Value='0'/><Setter Property='Padding' Value='12,8'/></Style>
  <Style TargetType='ToolTip' BasedOn='{StaticResource ClientControl}'><Setter Property='FontSize' Value='12'/><Setter Property='Padding' Value='10,6'/></Style>
  <Style TargetType='TextBox' BasedOn='{StaticResource ClientControl}'>
    <Setter Property='Padding' Value='10,5'/><Setter Property='VerticalContentAlignment' Value='Center'/>
    <Setter Property='SelectionBrush' Value='{DynamicResource ClientAccent}'/>
    <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='TextBox'>
      <Border x:Name='Chrome' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}' BorderThickness='{TemplateBinding BorderThickness}' CornerRadius='6'>
        <ScrollViewer x:Name='PART_ContentHost' Focusable='False'/>
      </Border>
      <ControlTemplate.Triggers><Trigger Property='IsKeyboardFocusWithin' Value='True'><Setter TargetName='Chrome' Property='BorderBrush' Value='{DynamicResource ClientAccentText}'/></Trigger><Trigger Property='IsEnabled' Value='False'><Setter TargetName='Chrome' Property='Opacity' Value='0.5'/></Trigger></ControlTemplate.Triggers>
    </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType='PasswordBox' BasedOn='{StaticResource ClientControl}'>
    <Setter Property='Padding' Value='10,5'/><Setter Property='VerticalContentAlignment' Value='Center'/>
    <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='PasswordBox'>
      <Border x:Name='Chrome' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}' BorderThickness='{TemplateBinding BorderThickness}' CornerRadius='6'><ScrollViewer x:Name='PART_ContentHost' Focusable='False'/></Border>
      <ControlTemplate.Triggers><Trigger Property='IsKeyboardFocusWithin' Value='True'><Setter TargetName='Chrome' Property='BorderBrush' Value='{DynamicResource ClientAccentText}'/></Trigger></ControlTemplate.Triggers>
    </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType='CheckBox' BasedOn='{StaticResource ClientControl}'>
    <Setter Property='Background' Value='Transparent'/><Setter Property='VerticalContentAlignment' Value='Center'/>
    <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='CheckBox'>
      <Grid Background='Transparent'>
        <Grid.ColumnDefinitions><ColumnDefinition Width='20'/><ColumnDefinition Width='*'/></Grid.ColumnDefinitions>
        <Border x:Name='Box' Width='18' Height='18' VerticalAlignment='Center' Background='{DynamicResource ClientCard}' BorderBrush='{DynamicResource ClientBorder}' BorderThickness='1' CornerRadius='4'>
          <Grid><Path x:Name='Tick' Data='M 3,7 L 6,10 L 12,3' Stroke='White' StrokeThickness='1.8' Visibility='Collapsed' StrokeStartLineCap='Round' StrokeEndLineCap='Round'/><Border x:Name='Dash' Background='White' Height='2' Width='8' Visibility='Collapsed'/></Grid>
        </Border>
        <ContentPresenter Grid.Column='1' Margin='9,0,0,0' VerticalAlignment='{TemplateBinding VerticalContentAlignment}' HorizontalAlignment='{TemplateBinding HorizontalContentAlignment}' RecognizesAccessKey='True'/>
      </Grid>
      <ControlTemplate.Triggers>
        <Trigger Property='IsChecked' Value='True'><Setter TargetName='Box' Property='Background' Value='{DynamicResource ClientAccent}'/><Setter TargetName='Box' Property='BorderBrush' Value='{DynamicResource ClientAccent}'/><Setter TargetName='Tick' Property='Visibility' Value='Visible'/></Trigger>
        <Trigger Property='IsChecked' Value='{x:Null}'><Setter TargetName='Box' Property='Background' Value='{DynamicResource ClientAccent}'/><Setter TargetName='Dash' Property='Visibility' Value='Visible'/></Trigger>
        <Trigger Property='IsKeyboardFocused' Value='True'><Setter TargetName='Box' Property='BorderBrush' Value='{DynamicResource ClientAccentText}'/></Trigger>
        <Trigger Property='IsEnabled' Value='False'><Setter Property='Opacity' Value='0.5'/></Trigger>
      </ControlTemplate.Triggers>
    </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType='TabControl' BasedOn='{StaticResource ClientControl}'>
    <Setter Property='Background' Value='Transparent'/><Setter Property='BorderThickness' Value='0'/>
    <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='TabControl'>
      <Grid KeyboardNavigation.TabNavigation='Local'>
        <Grid.RowDefinitions><RowDefinition Height='Auto'/><RowDefinition Height='*'/></Grid.RowDefinitions>
        <Border Background='{DynamicResource ClientSurface}' CornerRadius='8' Padding='4' Margin='0,0,0,16' HorizontalAlignment='Left'><TabPanel x:Name='HeaderPanel' IsItemsHost='True' KeyboardNavigation.TabIndex='1'/></Border>
        <Border Grid.Row='1' Background='{DynamicResource ClientCard}' BorderBrush='{DynamicResource ClientBorder}' BorderThickness='1' CornerRadius='10' Padding='0' ClipToBounds='True'>
          <ContentPresenter x:Name='PART_SelectedContentHost' ContentSource='SelectedContent' SnapsToDevicePixels='True'/>
        </Border>
      </Grid>
    </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType='TabItem' BasedOn='{StaticResource ClientControl}'>
    <Setter Property='Background' Value='Transparent'/><Setter Property='BorderBrush' Value='Transparent'/><Setter Property='Padding' Value='18,9'/><Setter Property='Foreground' Value='{DynamicResource ClientText}'/>
    <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='TabItem'>
      <Border x:Name='Chrome' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}' BorderThickness='1' CornerRadius='6' Margin='1,0'>
        <ContentPresenter x:Name='Header' ContentSource='Header' Margin='{TemplateBinding Padding}' HorizontalAlignment='Center' VerticalAlignment='Center' RecognizesAccessKey='True' TextElement.Foreground='{DynamicResource ClientMuted}'/>
      </Border>
      <ControlTemplate.Triggers>
        <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='Chrome' Property='Background' Value='{DynamicResource ClientCard}'/></Trigger>
        <Trigger Property='IsSelected' Value='True'><Setter TargetName='Header' Property='TextElement.Foreground' Value='{DynamicResource ClientAccentText}'/><Setter TargetName='Header' Property='TextElement.FontWeight' Value='SemiBold'/><Setter TargetName='Chrome' Property='Background' Value='{DynamicResource ClientCard}'/><Setter TargetName='Chrome' Property='BorderBrush' Value='{DynamicResource ClientBorder}'/></Trigger>
        <Trigger Property='IsKeyboardFocused' Value='True'><Setter TargetName='Chrome' Property='BorderBrush' Value='{DynamicResource ClientAccentText}'/></Trigger>
      </ControlTemplate.Triggers>
    </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType='ListBoxItem' BasedOn='{StaticResource ClientControl}'>
    <Setter Property='Padding' Value='10,10'/><Setter Property='Margin' Value='0,0,0,6'/><Setter Property='HorizontalContentAlignment' Value='Stretch'/><Setter Property='Background' Value='Transparent'/><Setter Property='BorderBrush' Value='Transparent'/>
    <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='ListBoxItem'>
      <Border x:Name='Chrome' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}' BorderThickness='1' CornerRadius='8' Padding='{TemplateBinding Padding}'><ContentPresenter HorizontalAlignment='{TemplateBinding HorizontalContentAlignment}'/></Border>
      <ControlTemplate.Triggers>
        <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='Chrome' Property='Background' Value='{DynamicResource ClientSurface}'/></Trigger>
        <Trigger Property='IsSelected' Value='True'><Setter TargetName='Chrome' Property='Background' Value='{DynamicResource ClientPrimarySoft}'/><Setter TargetName='Chrome' Property='BorderBrush' Value='{DynamicResource ClientBorder}'/></Trigger>
      </ControlTemplate.Triggers>
    </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType='Expander' BasedOn='{StaticResource ClientControl}'>
    <Setter Property='Background' Value='Transparent'/><Setter Property='BorderThickness' Value='0'/>
    <Setter Property='Template'><Setter.Value><ControlTemplate TargetType='Expander'>
      <StackPanel>
        <ToggleButton IsChecked='{Binding IsExpanded, RelativeSource={RelativeSource TemplatedParent}}' Foreground='{TemplateBinding Foreground}' Background='Transparent' BorderThickness='0' HorizontalContentAlignment='Stretch'>
          <ToggleButton.Template><ControlTemplate TargetType='ToggleButton'><Grid Background='Transparent' MinHeight='28'>
            <Grid.ColumnDefinitions><ColumnDefinition Width='*'/><ColumnDefinition Width='24'/></Grid.ColumnDefinitions>
            <ContentPresenter VerticalAlignment='Center'/>
            <Path x:Name='Arrow' Grid.Column='1' Data='M 1,1 L 6,6 L 11,1' Stroke='{DynamicResource ClientMuted}' StrokeThickness='1.5' HorizontalAlignment='Center' VerticalAlignment='Center' RenderTransformOrigin='0.5,0.5'/>
          </Grid><ControlTemplate.Triggers><Trigger Property='IsChecked' Value='True'><Setter TargetName='Arrow' Property='RenderTransform'><Setter.Value><RotateTransform Angle='180'/></Setter.Value></Setter></Trigger></ControlTemplate.Triggers></ControlTemplate></ToggleButton.Template>
          <ContentPresenter ContentSource='Header'/>
        </ToggleButton>
        <ContentPresenter x:Name='Body' ContentSource='Content' Visibility='Collapsed' Margin='0,16,0,0'/>
      </StackPanel>
      <ControlTemplate.Triggers><Trigger Property='IsExpanded' Value='True'><Setter TargetName='Body' Property='Visibility' Value='Visible'/></Trigger></ControlTemplate.Triggers>
    </ControlTemplate></Setter.Value></Setter>
  </Style>
</ResourceDictionary>";
}
